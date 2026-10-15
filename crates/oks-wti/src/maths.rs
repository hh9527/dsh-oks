//! 数学 filter（整组，照 jaq-std 的 `math.rs`，MIT）。
//! 全是纯函数：`libm` 的确定性实现，不读任何外部状态。
use crate::valx::{try_f64, try_i32};
use jaq_core::native::{bome, run, v, Filter, Fun};
use jaq_core::{DataT, RunPtr};
use jaq_std::ValT;

macro_rules! math0 {
    ($f:ident, $domain:expr, $codomain:expr) => {
        (stringify!($f), v(0), |cv| {
            bome((|| Ok($codomain(libm::$f($domain(&cv.1)?))))())
        })
    };
}
macro_rules! math2 {
    ($f:ident, $domain1:expr, $domain2:expr, $codomain:expr) => {
        (stringify!($f), v(2), |mut cv| {
            bome((|| {
                let y = cv.0.pop_var();
                let x = cv.0.pop_var();
                Ok($codomain(libm::$f($domain1(&x)?, $domain2(&y)?)))
            })())
        })
    };
}
macro_rules! math3 {
    ($f:ident, $d1:expr, $d2:expr, $d3:expr, $codomain:expr) => {
        (stringify!($f), v(3), |mut cv| {
            bome((|| {
                let z = cv.0.pop_var();
                let y = cv.0.pop_var();
                let x = cv.0.pop_var();
                Ok($codomain(libm::$f($d1(&x)?, $d2(&y)?, $d3(&z)?)))
            })())
        })
    };
}

macro_rules! f_f {
    ($f:ident) => {
        math0!($f, try_f64, D::V::from)
    };
}
macro_rules! f_i {
    ($f:ident) => {
        math0!($f, try_f64, |x| D::V::from(x as isize))
    };
}
macro_rules! f_fi {
    ($f:ident) => {
        math0!($f, try_f64, |(x, y)| [
            D::V::from(x),
            D::V::from(y as isize)
        ]
        .into_iter()
        .collect())
    };
}
macro_rules! f_ff {
    ($f:ident) => {
        math0!($f, try_f64, |(x, y)| [
            D::V::from(x),
            D::V::from(y)
        ]
        .into_iter()
        .collect())
    };
}
macro_rules! ff_f {
    ($f:ident) => {
        math2!($f, try_f64, try_f64, D::V::from)
    };
}
macro_rules! if_f {
    ($f:ident) => {
        math2!($f, try_i32, try_f64, D::V::from)
    };
}
macro_rules! fi_f {
    ($f:ident) => {
        math2!($f, try_f64, try_i32, D::V::from)
    };
}
macro_rules! fff_f {
    ($f:ident) => {
        math3!($f, try_f64, try_f64, try_f64, D::V::from)
    };
}

pub fn funs<D: DataT>() -> Box<[Fun<D>]>
where
    for<'a> D::V<'a>: ValT,
{
    let rename = |name, (_name, arity, f): Filter<RunPtr<D>>| (name, arity, f);
    let table: Box<[Filter<RunPtr<D>>]> = Box::new([
        f_f!(acos), f_f!(acosh), f_f!(asin), f_f!(asinh), f_f!(atan), f_f!(atanh),
        f_f!(cbrt), f_f!(cos), f_f!(cosh), f_f!(erf), f_f!(erfc), f_f!(exp),
        f_f!(exp10), f_f!(exp2), f_f!(expm1), f_f!(fabs),
        f_fi!(frexp),
        f_i!(ilogb),
        f_f!(j0), f_f!(j1), f_f!(lgamma), f_f!(log), f_f!(log10), f_f!(log1p), f_f!(log2),
        f_ff!(modf),
        rename("nearbyint", f_f!(round)),
        f_f!(rint),
        f_f!(sin), f_f!(sinh), f_f!(sqrt), f_f!(tan), f_f!(tanh), f_f!(tgamma), f_f!(trunc),
        f_f!(y0), f_f!(y1),
        ff_f!(atan2), ff_f!(copysign), ff_f!(fdim), ff_f!(fmax), ff_f!(fmin), ff_f!(fmod),
        ff_f!(hypot),
        if_f!(jn),
        fi_f!(ldexp),
        ff_f!(nextafter),
        ff_f!(pow),
        ff_f!(remainder),
        rename("scalbln", fi_f!(scalbn)),
        if_f!(yn),
        fff_f!(fma),
    ]);
    table.into_vec().into_iter().map(run).collect()
}
