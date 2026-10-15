//! 探索版：把 jaq 当**库**用，自己组装 std。
//!
//! 目标不是"能跑"，而是"能回答这个引擎会做什么"：
//!   - `base_funs()` 只给通用纯 filter（`length`/`keys`/…），不含 `env`/`now`；
//!   - `defs()` 是语言层的定义（`map`/`select`/…）；
//!   - 其余能力一律**不组装**——于是它们在语义上不存在，而不是"被拦住"。
//!
//! 对外只暴露一个 C ABI（wasm）：`alloc` / `dealloc` / `run`。
//! `run` 的返回缓冲：`[status u8][len u32 LE][payload]`，status 0 = 结果，1 = 错误。

mod format;
mod maths;
mod regexp;
mod time;
mod valx;

use jaq_all::load::{compile_errors, load_errors, FileReports, FileReportsDisp};
use jaq_core::load::{import, Arena, File, Loader};
use jaq_core::{Ctx, Vars};
use jaq_json::{read, Val};

/// 程序里不能有模块指令：这条求值路上没有文件系统。
///
/// jq 要求 `include` / `import` 出现在程序**最前面**（写在别处编译器自己会报错，也是响的），
/// 所以只看开头就够；跳过空白与注释，避免把 `.import`、`"import"`、`# import` 误判。
fn reject_module_directives(program: &str) -> Result<(), String> {
    let bytes = program.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'#' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        break;
    }
    for keyword in ["include", "import"] {
        let len = keyword.len();
        if bytes[i..].starts_with(keyword.as_bytes()) {
            let after = bytes.get(i + len);
            let is_word = after.is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'));
            if is_word {
                return Err(format!(
                    "程序里不能用 `{keyword}`：这条求值路上没有文件系统，模块与数据文件都进不来。\n"
                ) + "要用外面的值，先用工具把它落成材料，再当输入传给程序。");
            }
        }
    }
    Ok(())
}

/// 把编译期错误排成「文件名 + 行号 + 出错那一行」——与 jaq CLI 同一套排版，只是**不上色**
/// （这段文字要进模型上下文与回执，颜色是噪音）。路径由调用方给：`.work/kpi.jq` 就写它。
fn render(reports: Vec<FileReports<String>>) -> String {
    let mut out = String::new();
    for file_reports in &reports {
        out.push_str(&FileReportsDisp::new(file_reports).with_path(|p| p.clone()).to_string());
    }
    out.trim_end().to_string()
}

/// 跑一次：拒绝模块指令 → 解析输入 → 组装 std → 编译（含"没有文件系统"的那一步）→ 求值。
///
/// `max_chars` 是输出的字符上限（0 = 不限）：到点就停并回退到最后一个换行——
/// 与"进程被 kill 掉"时的语义一致，绝不留下半个 JSON 值。返回的第二个值表示截断。
fn evaluate(program: &str, path: &str, input: &str, max_chars: usize) -> Result<(String, bool), String> {
    reject_module_directives(program)?;
    let input = read::parse_single(input.as_bytes()).map_err(|e| format!("输入不是合法的 JSON：{e}"))?;
    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    // 白名单就是这一行：核心通用 filter + jaq-std 的纯部分 + 我们自己的组（数学 / 正则 / 格式化 /
    // 时间 / 报错的桩）+ json 的转换。`env` / `now` / `localtime` / `strflocaltime` / `input` /
    // `inputs` 不在任何一处。语言层的 `defs.jq` 会引用一部分原生名，缺一个就会在任何程序上报错
    //（编译器在编译期解析定义）——所以下面这几组必须能把 `defs.jq` 引用的名字全部覆盖。
    let funs = jaq_core::funs()
        .chain(jaq_std::base_funs())
        .chain(time::funs())
        .chain(time::forbidden::funs())
        .chain(maths::funs())
        .chain(regexp::funs())
        .chain(format::funs())
        .chain(jaq_json::funs());
    let path = if path.is_empty() { "<inline>".to_string() } else { path.to_string() };
    let arena = Arena::default();
    let loader: Loader<&str, String, _> = Loader::new(defs);
    let modules = loader
        .load(&arena, File { code: program, path: path.clone() })
        .map_err(|errs| render(load_errors(errs)))?;
    // 这一步就是"没有文件系统"的落点：模块与数据文件都在这里被拒。少了它，未解析的导入变量
    // 会留到运行时，一用就 panic（wasm 里是 trap，实例报废）。
    import(&modules, |_| Err("file loading not supported".into()))
        .map_err(|errs| render(load_errors(errs)))?;
    let filter = jaq_core::Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|errs| render(compile_errors(errs)))?;
    let ctx = Ctx::<jaq_core::data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
    let mut out = String::new();
    let mut truncated = false;
    for value in filter.id.run((ctx, input)) {
        let value = jaq_core::unwrap_valr(value).map_err(|e| format!("{e}"))?;
        out.push_str(&value.to_string());
        out.push('\n');
        if max_chars > 0 && out.len() > max_chars {
            match out.rfind('\n') {
                Some(cut) => out.truncate(cut + 1),
                None => out.clear(),
            }
            truncated = true;
            break;
        }
    }
    Ok((out, truncated))
}

fn boxed(bytes: Vec<u8>) -> *mut u8 {
    Box::into_raw(bytes.into_boxed_slice()) as *mut u8
}

/// 调用方要一块 `len` 字节的缓冲（用于放程序或输入）。
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    boxed(vec![0u8; len])
}

/// 归还 `alloc` 或 `run` 给的缓冲；`len` 必须是当初给的那个长度。
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

/// `run(程序, 程序名, 输入, 上限) -> [status][len][payload]`。
///
/// `程序名`只用于报错排版（`.work/kpi.jq` → 报错里就写这个名字）；空串按 `<inline>` 处理。
/// `上限`是输出字符上限（0 = 不限）。
/// 状态：`0` = 结果、`1` = 错误、`2` = 到上限被截断（`payload` 是回退到最后一个换行的那一段）。
#[no_mangle]
pub extern "C" fn run(
    program_ptr: *const u8,
    program_len: usize,
    path_ptr: *const u8,
    path_len: usize,
    input_ptr: *const u8,
    input_len: usize,
    max_chars: usize,
) -> *mut u8 {
    let program = unsafe { core::slice::from_raw_parts(program_ptr, program_len) };
    let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    let input = unsafe { core::slice::from_raw_parts(input_ptr, input_len) };
    let (status, payload) = match evaluate(
        &String::from_utf8_lossy(program),
        &String::from_utf8_lossy(path),
        &String::from_utf8_lossy(input),
        max_chars,
    ) {
        Ok((text, false)) => (0u8, text),
        Ok((text, true)) => (2u8, text),
        Err(err) => (1u8, err),
    };
    let bytes = payload.into_bytes();
    let mut out = Vec::with_capacity(5 + bytes.len());
    out.push(status);
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&bytes);
    boxed(out)
}
