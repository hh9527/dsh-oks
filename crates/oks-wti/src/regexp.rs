//! 正则 filter（整组，照 jaq-std 的 `regex.rs` + 它那张表，MIT）。
//! 纯函数：正则引擎是编进产物的，不读外部状态；偏移按**字符**数报，与 jq 一致。
use crate::valx::try_str;
use bstr::ByteSlice;
use jaq_core::native::{bome, run, v, Filter, Fun};
use jaq_core::{DataT, Error, RunPtr, ValR, ValT as _};
use jaq_std::ValT;
use regex_bites::bytes::{self as regex, Error as RegexError, Regex, RegexBuilder};

#[derive(Copy, Clone, Default)]
pub struct Flags {
    /// 全局搜索
    g: bool,
    /// 忽略空匹配
    n: bool,
    /// 大小写不敏感
    i: bool,
    /// 多行：`^`/`$` 匹配行首行尾
    m: bool,
    /// 单行：`.` 也匹配换行
    s: bool,
    /// 交换贪婪语义
    l: bool,
    /// 扩展模式：忽略空白与 `#` 注释
    x: bool,
}

impl Flags {
    pub fn new(flags: &str) -> Result<Self, char> {
        let mut out = Self::default();
        for flag in flags.chars() {
            match flag {
                'g' => out.g = true,
                'n' => out.n = true,
                'i' => out.i = true,
                'm' => out.m = true,
                's' => out.s = true,
                'l' => out.l = true,
                'x' => out.x = true,
                'p' => {
                    out.m = true;
                    out.s = true;
                }
                c => return Err(c),
            }
        }
        Ok(out)
    }

    pub fn ignore_empty(self) -> bool {
        self.n
    }

    pub fn global(self) -> bool {
        self.g
    }

    fn impact(self, builder: &mut RegexBuilder) -> &mut RegexBuilder {
        builder
            .case_insensitive(self.i)
            .multi_line(self.m)
            .dot_matches_new_line(self.s)
            .swap_greed(self.l)
            .ignore_whitespace(self.x)
    }

    pub fn regex(self, re: &str) -> Result<Regex, RegexError> {
        let mut builder = RegexBuilder::new(re);
        self.impact(&mut builder).build()
    }
}

type CharIndices<'a> =
    core::iter::Chain<bstr::CharIndices<'a>, core::iter::Once<(usize, usize, char)>>;

/// 字节偏移 ↔ 字符偏移的映射。
pub struct ByteChar<'a>(core::iter::Peekable<core::iter::Enumerate<CharIndices<'a>>>);

impl<'a> ByteChar<'a> {
    pub fn new(s: &'a [u8]) -> Self {
        let last = core::iter::once((s.len(), 0, '\0'));
        Self(s.char_indices().chain(last).enumerate().peekable())
    }

    /// 字节偏移 → 字符偏移；必须以**递增**的字节偏移调用。
    fn char_of_byte(&mut self, byte_offset: usize) -> Option<usize> {
        loop {
            let (char_i, (byte_i, _, _char)) = self.0.peek()?;
            if byte_offset == *byte_i {
                return Some(*char_i);
            }
            self.0.next();
        }
    }
}

pub struct Match<B, S> {
    pub offset: usize,
    pub length: usize,
    pub string: B,
    pub name: Option<S>,
}

impl<'a> Match<&'a [u8], &'a str> {
    pub fn new(bc: &mut ByteChar, m: regex::Match<'a>, name: Option<&'a str>) -> Self {
        Self {
            offset: bc.char_of_byte(m.start()).unwrap(),
            length: m.as_bytes().chars().count(),
            string: m.as_bytes(),
            name,
        }
    }

    pub fn fields<T: From<isize> + From<String> + 'a>(
        &self,
        f: impl Fn(&'a [u8]) -> T,
    ) -> impl Iterator<Item = (T, T)> + '_ {
        [
            ("offset", (self.offset as isize).into()),
            ("length", (self.length as isize).into()),
            ("string", f(self.string)),
        ]
        .into_iter()
        .chain(self.name.iter().map(|n| ("name", (*n).to_string().into())))
        .map(|(k, v)| (k.to_string().into(), v))
    }
}

pub enum Part<B, S> {
    Matches(Vec<Match<B, S>>),
    Mismatch(B),
}

/// 把正则作用在输入上。
///
/// `sm` 决定两件事：1) 是否输出**不匹配**的那些片段；2) 是否输出匹配本身。
pub fn regex<'a>(s: &'a [u8], re: &'a Regex, flags: Flags, sm: (bool, bool)) -> Vec<Part<&'a [u8], &'a str>> {
    let (mi, ma) = sm;
    let mut last_byte = 0;
    let mut bc = ByteChar::new(s);
    let mut out = Vec::new();

    for c in re.captures_iter(s) {
        let whole = c.get(0).unwrap();
        if flags.ignore_empty() && whole.as_bytes().is_empty() {
            continue;
        }
        let match_names = c.iter().zip(re.capture_names());
        let matches = match_names.filter_map(|(m, n)| Some(Match::new(&mut bc, m?, n)));
        if mi {
            out.push(Part::Mismatch(&s[last_byte..whole.start()]));
            last_byte = whole.end();
        }
        if ma {
            out.push(Part::Matches(matches.collect()));
        }
        if !flags.global() {
            break;
        }
    }
    if mi {
        out.push(Part::Mismatch(&s[last_byte..]));
    }
    out
}

fn re<'a, D: DataT>(s: bool, m: bool, mut cv: jaq_core::Cv<'a, D>) -> ValR<D::V<'a>>
where
    D::V<'a>: ValT,
{
    let flags = cv.0.pop_var();
    let regex = cv.0.pop_var();

    use crate::regexp::Part::{Matches, Mismatch};
    let fail_flag = |e| Error::str(format_args!("invalid regex flag: {e}"));
    let fail_re = |e| Error::str(format_args!("invalid regex: {e}"));

    let flags = Flags::new(try_str(&flags)?).map_err(fail_flag)?;
    let regex = flags.regex(try_str(&regex)?).map_err(fail_re)?;
    let out = crate::regexp::regex(cv.1.try_as_utf8_bytes()?, &regex, flags, (s, m));
    let sub = |s| cv.1.as_sub_str(s);
    let out = out.into_iter().map(|out| match out {
        Matches(ms) => ms
            .into_iter()
            .map(|m| D::V::from_map(m.fields(sub)))
            .collect(),
        Mismatch(s) => Ok(sub(s)),
    });
    out.collect()
}

pub fn funs<D: DataT>() -> Box<[Fun<D>]>
where
    for<'a> D::V<'a>: ValT,
{
    let table: Box<[Filter<RunPtr<D>>]> = Box::new([
        ("matches", v(2), |cv| bome(re(false, true, cv))),
        ("split_matches", v(2), |cv| bome(re(true, true, cv))),
        ("split_", v(2), |cv| bome(re(true, false, cv))),
    ]);
    table.into_vec().into_iter().map(run).collect()
}
