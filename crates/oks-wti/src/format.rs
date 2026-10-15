//! 格式化 filter（整组，照 jaq-std 的 format 表，MIT）：HTML 转义 / 反转义、URI、base64。
//! 纯函数：一个字节进、一个字节出，没有环境也没有文件。
use crate::valx::map_utf8_str;
use base64::{engine::general_purpose::STANDARD, Engine};
use jaq_core::native::{bome, run, v, Filter, Fun};
use jaq_core::{DataT, Error, RunPtr};
use jaq_std::ValT;

const HTML_PATS: [&str; 5] = ["<", ">", "&", "'", "\""];
const HTML_REPS: [&str; 5] = ["&lt;", "&gt;", "&amp;", "&apos;", "&quot;"];

/// 单趟替换（jaq-std 用 aho-corasick 的 `replace_all`，语义是"替换出来的串不再被扫"）。
fn replace(s: &[u8], pats: &[&str], reps: &[&str]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    'outer: while i < s.len() {
        for (pat, rep) in pats.iter().zip(reps) {
            let pat = pat.as_bytes();
            if s[i..].starts_with(pat) {
                out.extend_from_slice(rep.as_bytes());
                i += pat.len();
                continue 'outer;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

pub fn funs<D: DataT>() -> Box<[Fun<D>]>
where
    for<'a> D::V<'a>: ValT,
{
    let table: Box<[Filter<RunPtr<D>>]> = Box::new([
        ("escape_html", v(0), |cv| {
            bome(map_utf8_str(cv.1, |s| replace(s, &HTML_PATS, &HTML_REPS)))
        }),
        ("unescape_html", v(0), |cv| {
            bome(map_utf8_str(cv.1, |s| replace(s, &HTML_REPS, &HTML_PATS)))
        }),
        ("encode_uri", v(0), |cv| {
            bome(map_utf8_str(cv.1, |s| urlencoding::encode_binary(s).to_string()))
        }),
        ("decode_uri", v(0), |cv| {
            bome(map_utf8_str(cv.1, |s| urlencoding::decode_binary(s).to_vec()))
        }),
        ("encode_base64", v(0), |cv| {
            bome(map_utf8_str(cv.1, |s| STANDARD.encode(s)))
        }),
        ("decode_base64", v(0), |cv| {
            bome(cv.1.try_as_utf8_bytes().and_then(|s| {
                STANDARD
                    .decode(s)
                    .map_err(Error::str)
                    .map(ValT::from_utf8_bytes)
            }))
        }),
    ]);
    table.into_vec().into_iter().map(run).collect()
}
