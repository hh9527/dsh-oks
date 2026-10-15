//! 值的小工具：jaq-std 把这些放在一个**私有** trait（`ValTx`）里，这里照抄一份（MIT，jaq 3.0.3）。
//! 只做「缺省即报错」的取值，不碰任何外部状态。
use jaq_core::{Error, ValR};
use jaq_std::ValT;

pub fn try_f64<V: ValT>(v: &V) -> Result<f64, Error<V>> {
    v.as_f64().ok_or_else(|| Error::typ(v.clone(), "number"))
}

pub fn try_i32<V: ValT>(v: &V) -> Result<i32, Error<V>> {
    v.as_isize()
        .and_then(|i| i.try_into().ok())
        .ok_or_else(|| Error::typ(v.clone(), "integer"))
}

pub fn try_str<'a, V: ValT>(v: &'a V) -> Result<&'a str, Error<V>> {
    core::str::from_utf8(v.try_as_utf8_bytes()?).map_err(Error::str)
}

pub fn into_vec<V: ValT>(v: V) -> Result<Vec<V>, Error<V>> {
    v.into_seq().map_err(|v| Error::typ(v, "array"))
}

pub fn map_utf8_str<V: ValT, B: AsRef<[u8]> + Send + 'static>(v: V, f: impl FnOnce(&[u8]) -> B) -> ValR<V> {
    Ok(V::from_utf8_bytes(f(v.try_as_utf8_bytes()?)))
}
