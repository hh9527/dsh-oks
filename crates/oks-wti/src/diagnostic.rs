//! 运行时错误在格式化过程中限长，错误值通过 Display 逐段写入。
use std::fmt::{self, Display, Write};

/// 单条运行时诊断的 UTF-8 字节预算（包含截断标记）。
const MAX_BYTES: usize = 4096;
const TRUNCATED: &str = "\n…（错误信息已截断）";

struct Bounded {
    text: String,
    truncated: bool,
}

impl Write for Bounded {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let remaining = (MAX_BYTES - TRUNCATED.len()).saturating_sub(self.text.len());
        if text.len() <= remaining {
            self.text.push_str(text);
            return Ok(());
        }
        let mut end = remaining;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.text.push_str(&text[..end]);
        self.truncated = true;
        // jaq 的格式化实现会传播写入失败，停止遍历后续值和片段。
        Err(fmt::Error)
    }
}

pub fn runtime_error(error: impl Display) -> String {
    let mut out = Bounded {
        text: String::new(),
        truncated: false,
    };
    let _ = write!(&mut out, "{error}");
    if out.truncated {
        out.text.push_str(TRUNCATED);
    }
    out.text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn small_error_stays_complete() {
        assert_eq!(
            runtime_error("cannot index 1 with \"data\""),
            "cannot index 1 with \"data\""
        );
    }

    #[test]
    fn unicode_is_bounded_and_marked() {
        let out = runtime_error("中文🙂".repeat(MAX_BYTES));
        assert!(out.len() <= MAX_BYTES);
        assert!(out.ends_with(TRUNCATED));
    }

    #[test]
    fn stops_producing_the_rest() {
        struct Large<'a>(&'a Cell<usize>);
        impl Display for Large<'_> {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                for _ in 0..1_000_000 {
                    self.0.set(self.0.get() + 1);
                    f.write_str("value,")?;
                }
                Ok(())
            }
        }
        let writes = Cell::new(0);
        let out = runtime_error(Large(&writes));
        assert!(writes.get() < 1000);
        assert!(out.len() <= MAX_BYTES);
        assert!(out.ends_with(TRUNCATED));
    }
}
