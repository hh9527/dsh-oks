//! 将 jaq 作为库组装为纯求值器，支持逐次输入与实例内常驻文档。
//!
//! 目标不是"能跑"，而是"能回答这个引擎会做什么"：
//!   - `base_funs()` 只给通用纯 filter（`length`/`keys`/…），不含 `env`/`now`；
//!   - `defs()` 是语言层的定义（`map`/`select`/…）；
//!   - 其余能力一律**不组装**——于是它们在语义上不存在，而不是"被拦住"。
//!
//! C ABI：`alloc` / `dealloc` / `run` / `check_program` / `load_document` / `run_document`。
//! `run` 的返回缓冲：`[status u8][len u32 LE][payload]`，status 0 = 单值 JSON，1 = 错误文本，2 = 超限值的形状 JSON，3 = 结构化编译诊断 JSON。

mod diagnostic;
mod format;
mod maths;
mod output;
mod regexp;
mod time;
mod valx;

use jaq_all::load::{compile_errors, load_errors, FileReports, FileReportsDisp};
use jaq_core::load::{import, Arena, File, Import, Loader};
use jaq_core::{Ctx, Vars};
use jaq_json::{read, Val};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

type Compiled = jaq_core::Filter<jaq_core::data::JustLut<Val>>;
const MAX_PROGRAMS: usize = 32;
const MAX_PROGRAM_SOURCE_BYTES: usize = 256 * 1024;

thread_local! {
    // 文档随实例存续；Val 的 clone 共享底层值，jq 更新产生新的值。
    static PROGRAMS: RefCell<VecDeque<(String, Rc<Compiled>)>> = const { RefCell::new(VecDeque::new()) };
    static DOCUMENTS: RefCell<Vec<Val>> = const { RefCell::new(Vec::new()) };
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

// Relative UTF-8 ranges cross the ABI before any human formatting loses them.
struct CompileFailure { message: String, diagnostics: Vec<String> }
fn json_text(text: &str) -> String { Val::from(text.to_string()).to_string() }
fn diagnostic_json(path: &str, stage: &str, message: &str, range: core::ops::Range<usize>, related: Vec<core::ops::Range<usize>>) -> String {
    let related = related.into_iter().map(|r| format!("{{\"start\":{},\"end\":{}}}",r.start,r.end)).collect::<Vec<_>>().join(",");
    format!("{{\"path\":{},\"stage\":{},\"message\":{},\"start\":{},\"end\":{},\"related\":[{}]}}",json_text(path),json_text(stage),json_text(&diagnostic::runtime_error(message.to_string())),range.start,range.end,related)
}
fn load_failure(errs: jaq_core::load::Errors<&str,String>) -> CompileFailure {
    use jaq_core::load::{Error, lex::Expect, span};
    let mut diagnostics=Vec::new();
    for (file,error) in &errs {
        match error {
            Error::Lex(errors) => for (expected,found) in errors {
                let token=&found[..found.char_indices().nth(1).map_or(found.len(), |(i,_)|i)];
                let related=match expected { Expect::Delim(open)=>vec![span(file.code,open)], _=>vec![] };
                diagnostics.push(diagnostic_json(&file.path,"lex",&format!("expected {}",expected.as_str()),span(file.code,token),related));
            },
            Error::Parse(errors) => for (expected,found) in errors {
                diagnostics.push(diagnostic_json(&file.path,"parse",&format!("expected {}",expected.as_str()),span(file.code,found),vec![]));
            },
            Error::Io(errors) => for (found,message) in errors {
                diagnostics.push(diagnostic_json(&file.path,"load",message,span(file.code,found),vec![]));
            },
        }
    }
    diagnostics.truncate(16);
    CompileFailure {message:render(load_errors(errs)),diagnostics}
}
fn compile_failure(errs: jaq_core::compile::Errors<&str,String>) -> CompileFailure {
    let diagnostics=errs.iter().flat_map(|(file,errors)|errors.iter().map(|(found,undefined)|
        diagnostic_json(&file.path,"compile",&format!("undefined {}",undefined.as_str()),jaq_core::load::span(file.code,found),vec![])
    )).take(16).collect();
    CompileFailure{message:render(compile_errors(errs)),diagnostics}
}

/// 跑一次：解析输入 → 取得或编译程序（`include` / `import` 在装载时被拒）→ 求值。
///
/// 程序必须恰好输出一个 JSON 值；返回完整 JSON 或超限值的形状摘要。
/// `max_bytes` 为序列化字节预算（0 = 不限），第二个返回值标记超限。
fn evaluate(program: &str, path: &str, input: &str, max_bytes: usize) -> Result<(String, bool), String> {
    let input = read::parse_single(input.as_bytes()).map_err(|e| format!("输入不是合法的 JSON：{e}"))?;
    evaluate_value(program, path, input, max_bytes)
}

/// The successful compiler product owns its graph; no arena or source lifetime escapes.
/// Cache identity excludes the diagnostic path so moving/renaming an asset can reuse it.
fn compiled(program: &str, path: &str) -> Result<(Rc<Compiled>, bool), String> {
    compiled_checked(program,path).map_err(|error|error.message)
}
fn compiled_checked(program: &str, path: &str) -> Result<(Rc<Compiled>, bool), CompileFailure> {
    if let Some(filter) = PROGRAMS.with(|programs| {
        let mut programs = programs.borrow_mut();
        let index = programs.iter().position(|(source, _)| source == program)?;
        let entry = programs.remove(index)?;
        let filter = entry.1.clone();
        programs.push_back(entry);
        Some(filter)
    }) {
        return Ok((filter, true));
    }
    let filter = Rc::new(compile_program(program, path)?);
    if program.len() <= MAX_PROGRAM_SOURCE_BYTES {
        PROGRAMS.with(|programs| {
            let mut programs = programs.borrow_mut();
            while programs.len() >= MAX_PROGRAMS
                || programs.iter().map(|(source, _)| source.len()).sum::<usize>() + program.len() > MAX_PROGRAM_SOURCE_BYTES
            {
                programs.pop_front();
            }
            programs.push_back((program.to_string(), filter.clone()));
        });
    }
    Ok((filter, false))
}

fn compile_program(program: &str, path: &str) -> Result<Compiled, CompileFailure> {
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
        .map_err(load_failure)?;
    // 这一步就是"没有文件系统"的落点：模块与数据文件都在这里被拒。少了它，未解析的导入变量
    // 会留到运行时，一用就 panic（wasm 里是 trap，实例报废）。
    import(&modules, |Import { path, .. }| {
        Err(format!(
            "这条求值路上没有文件系统：模块与数据文件（`{path}`）都进不来。\n             要用外面的值，先用工具把它落成材料，再当输入传给程序。"
        ))
    })
        .map_err(load_failure)?;
    jaq_core::Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(compile_failure)
}

fn evaluate_value(program: &str, path: &str, input: Val, max_bytes: usize) -> Result<(String, bool), String> {
    let (filter, _) = compiled(program, path)?;
    let ctx = Ctx::<jaq_core::data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
    let mut values = filter.id.run((ctx, input));
    let first = values.next().ok_or("jq 程序必须恰好输出一个值：当前无输出；空结果请输出 [] 或 null。")?;
    let value = jaq_core::unwrap_valr(first).map_err(diagnostic::runtime_error)?;
    if let Some(second) = values.next() {
        jaq_core::unwrap_valr(second).map_err(diagnostic::runtime_error)?;
        return Err("jq 程序必须恰好输出一个值：当前有多个输出；收集结果请使用 [表达式]。".into());
    }
    Ok(output::encode(&value, max_bytes))
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
/// `上限`是输出 UTF-8 字节预算（0 = 不限）。
/// 状态：`0` = 单值 JSON、`1` = 错误文本、`2` = 超限值的形状 JSON。
#[no_mangle]
pub extern "C" fn run(
    program_ptr: *const u8,
    program_len: usize,
    path_ptr: *const u8,
    path_len: usize,
    input_ptr: *const u8,
    input_len: usize,
    max_bytes: usize,
) -> *mut u8 {
    let program = unsafe { core::slice::from_raw_parts(program_ptr, program_len) };
    let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    let input = unsafe { core::slice::from_raw_parts(input_ptr, input_len) };
    let (status, payload) = match evaluate(
        &String::from_utf8_lossy(program),
        &String::from_utf8_lossy(path),
        &String::from_utf8_lossy(input),
        max_bytes,
    ) {
        Ok((text, false)) => (0u8, text),
        Ok((text, true)) => (2u8, text),
        Err(err) => (1u8, err),
    };
    reply(status, payload)
}

fn reply(status: u8, payload: String) -> *mut u8 {
    let bytes = payload.into_bytes();
    let mut out = Vec::with_capacity(5 + bytes.len());
    out.push(status);
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&bytes);
    boxed(out)
}

/// Parse and compile without evaluating any input. Success reports compiler-cache reuse.
#[no_mangle]
pub extern "C" fn check_program(
    program_ptr: *const u8,
    program_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> *mut u8 {
    let program = unsafe { core::slice::from_raw_parts(program_ptr, program_len) };
    let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    match compiled_checked(&String::from_utf8_lossy(program), &String::from_utf8_lossy(path)) {
        Ok((_, cached)) => reply(0, format!("{{\"cached\":{cached}}}")),
        Err(error) => reply(3, format!("{{\"message\":{},\"diagnostics\":[{}]}}",json_text(&diagnostic::runtime_error(error.message)),error.diagnostics.join(","))),
    }
}

/// 解析并常驻一份 JSON，成功时返回 JSON 数字 `handle`，文档与实例同生命周期。
#[no_mangle]
pub extern "C" fn load_document(ptr: *const u8, len: usize) -> *mut u8 {
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
    match read::parse_single(bytes) {
        Ok(value) => {
            let handle = DOCUMENTS.with(|docs| {
                let mut docs = docs.borrow_mut();
                docs.push(value);
                docs.len()
            });
            reply(0, handle.to_string())
        }
        Err(error) => reply(1, format!("输入不是合法的 JSON：{error}")),
    }
}

/// 在已解析文档上求值；非空 name 将文档包装为该键下的值，返回缓冲遵循 `run`。
#[no_mangle]
pub extern "C" fn run_document(
    handle: usize,
    program_ptr: *const u8,
    program_len: usize,
    path_ptr: *const u8,
    path_len: usize,
    name_ptr: *const u8,
    name_len: usize,
    max_bytes: usize,
) -> *mut u8 {
    let value = DOCUMENTS.with(|docs| docs.borrow().get(handle.wrapping_sub(1)).cloned());
    let Some(input) = value else {
        return reply(1, format!("知识文档 handle 无效：{handle}"));
    };
    let name = unsafe { core::slice::from_raw_parts(name_ptr, name_len) };
    let input = if name.is_empty() {
        input
    } else {
        Val::obj([(Val::utf8_str(name.to_vec()), input)].into_iter().collect())
    };
    let program = unsafe { core::slice::from_raw_parts(program_ptr, program_len) };
    let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    match evaluate_value(
        &String::from_utf8_lossy(program),
        &String::from_utf8_lossy(path),
        input,
        max_bytes,
    ) {
        Ok((text, false)) => reply(0, text),
        Ok((text, true)) => reply(2, text),
        Err(error) => reply(1, error),
    }
}
