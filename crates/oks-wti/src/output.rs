//! 单值结果的有界序列化，以及直接从 Val 提取的形状摘要。
use jaq_json::Val;
use std::fmt::{self, Write};

struct BoundedJson {
    text: String,
    max_bytes: usize,
}

impl Write for BoundedJson {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        if self.max_bytes > 0 && text.len() > self.max_bytes.saturating_sub(self.text.len()) {
            return Err(fmt::Error);
        }
        self.text.push_str(text);
        Ok(())
    }
}

/// 成功返回完整 JSON；超出字节预算时返回同一值的形状，第二项标记超限。
pub fn encode(value: &Val, max_bytes: usize) -> (String, bool) {
    let mut out = BoundedJson { text: String::new(), max_bytes };
    if write!(&mut out, "{value}").is_ok() {
        (out.text, false)
    } else {
        (shape(value), true)
    }
}

fn shape(value: &Val) -> String {
    match value {
        Val::Null => "{\"type\":\"null\"}".into(),
        Val::Bool(_) => "{\"type\":\"boolean\"}".into(),
        Val::Num(_) => "{\"type\":\"number\"}".into(),
        Val::BStr(bytes) | Val::TStr(bytes) => {
            let size = String::from_utf8_lossy(bytes).chars().count();
            format!("{{\"type\":\"string\",\"size\":{size}}}")
        }
        Val::Arr(values) => format!("{{\"type\":\"array\",\"size\":{}}}", values.len()),
        Val::Obj(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            // 与 JS Shape 一致：字符串按 UTF-16 排序，最多列出 20 个键。
            keys.sort_by_cached_key(|key| match key {
                Val::BStr(bytes) | Val::TStr(bytes) => String::from_utf8_lossy(bytes).encode_utf16().collect::<Vec<_>>(),
                _ => key.to_string().encode_utf16().collect(),
            });
            let keys = keys.into_iter().take(20).map(ToString::to_string).collect::<Vec<_>>().join(",");
            format!("{{\"type\":\"object\",\"size\":{},\"keys\":[{keys}]}}", values.len())
        }
    }
}
