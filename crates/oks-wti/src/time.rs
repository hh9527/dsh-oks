//! 时间 filter：**显式时区、没有时钟**。
//!
//! 语义照 jaq-std 的 `time.rs`（MIT，jaq 3.0.3）对齐，好让用惯 jq 的人不踩空；差别只有三处，
//! 而这三处正是我们要的：
//!   1. 不提供 `now`——时间只能从输入来；
//!   2. 不提供 `localtime` / `strflocaltime`——格式化要么 UTC，要么**显式给 zone**；
//!   3. 时区数据是编进产物的（jiff 的 static tzdb），不读系统时区库。
use crate::valx::{into_vec, try_f64, try_str};
use jaq_core::native::{bome, run, unary, v, Filter, Fun};
use jaq_core::{DataT, Error, RunPtr, ValR, ValXs};
use jaq_std::ValT;
use jiff::{civil::DateTime, fmt::strtime, tz::TimeZone, Span, Timestamp};

/// 数字（秒，可带小数）→ 时间戳。整数按秒，小数按微秒精度。
fn epoch_to_timestamp<V: ValT>(v: &V) -> Result<Timestamp, Error<V>> {
    let micros = match v.as_isize() {
        Some(i) => i as i64 * 1_000_000,
        None => (try_f64(v)? * 1_000_000.0) as i64,
    };
    Timestamp::from_microsecond(micros).map_err(Error::str)
}

/// 时间戳 → 数字（秒）；有小数部分时保留小数。
fn timestamp_to_epoch<V: ValT>(ts: Timestamp, frac: bool) -> ValR<V> {
    if frac {
        Ok((ts.as_microsecond() as f64 / 1e6).into())
    } else {
        let seconds = ts.as_second();
        isize::try_from(seconds)
            .map(V::from)
            .or_else(|_| V::from_num(&seconds.to_string()))
    }
}

/// jq 的"分解时间"数组：`[年, 月(0–11), 日, 时, 分, 秒, 星期(周日=0), 年内第几天(0–365)]`。
fn array_to_datetime<V: ValT>(v: &[V]) -> Option<Result<DateTime, jiff::Error>> {
    let [year, month, day, hour, min, sec]: &[V; 6] = v.get(..6)?.try_into().ok()?;
    let sec = sec.as_f64()?;
    let i8_of = |v: &V| -> Option<i8> { v.as_isize()?.try_into().ok() };
    Some(DateTime::new(
        year.as_isize()?.try_into().ok()?,
        i8_of(month)? + 1,
        i8_of(day)?,
        i8_of(hour)?,
        i8_of(min)?,
        sec.floor() as i8,
        (sec.fract() * 1e9) as i32,
    ))
}

fn datetime_to_array<V: ValT>(dt: DateTime) -> [V; 8] {
    [
        V::from(dt.year() as isize),
        V::from(dt.month() as isize - 1),
        V::from(dt.day() as isize),
        V::from(dt.hour() as isize),
        V::from(dt.minute() as isize),
        if dt.subsec_nanosecond() > 0 {
            V::from(dt.second() as f64 + dt.subsec_nanosecond() as f64 / 1e9)
        } else {
            V::from(dt.second() as isize)
        },
        V::from(dt.weekday().to_sunday_zero_offset() as isize),
        V::from(dt.day_of_year() as isize - 1),
    ]
}

/// RFC 3339 文本 → epoch 秒（与 jq 一样只认这个子集；小数秒保留小数）。
fn from_iso8601<V: ValT>(s: &str) -> ValR<V> {
    timestamp_to_epoch(s.parse().map_err(Error::str)?, s.contains('.'))
}

/// epoch 秒 → RFC 3339 文本（UTC）。
fn to_iso8601<V: ValT>(v: &V) -> Result<String, Error<V>> {
    let ts = match v.as_isize() {
        Some(i) => Timestamp::from_second(i as i64),
        None => Timestamp::from_microsecond((try_f64(v)? * 1e6) as i64),
    };
    Ok(ts.map_err(Error::str)?.to_string())
}

/// 按给定时区格式化（数字＝时刻，数组＝该时区的墙钟）。
fn strftime<V: ValT>(v: &V, fmt: &str, zone: TimeZone) -> ValR<V> {
    let fail = || Error::str("cannot convert this value to time");
    let zoned = match into_vec(v.clone()) {
        Ok(parts) => array_to_datetime(&parts)
            .ok_or_else(fail)?
            .and_then(|dt| dt.to_zoned(zone))
            .map_err(Error::str)?,
        Err(_) => epoch_to_timestamp(v)?.to_zoned(zone),
    };
    strtime::format(fmt, &zoned).map(V::from).map_err(Error::str)
}

/// 按给定时区把时刻拆成"分解时间"数组（`gmtime` 的时区版：输出形状与它一样，只是时区显式传）。
fn gmtime<V: ValT>(v: &V, zone: TimeZone) -> ValR<V> {
    let dt = epoch_to_timestamp(v)?.to_zoned(zone).into();
    datetime_to_array(dt).into_iter().map(Ok).collect()
}

/// 文本 + 格式 → "分解时间"数组（文本不带偏移时按 UTC 解释）。
fn strptime<V: ValT>(s: &str, fmt: &str) -> ValR<V> {
    let mut bdt = strtime::BrokenDownTime::parse(fmt, s).map_err(Error::str)?;
    if (bdt.offset(), bdt.iana_time_zone()) == (None, None) {
        bdt.set_offset(Some(jiff::tz::Offset::UTC));
    }
    let dt = bdt.to_zoned().map_err(Error::str)?.into();
    datetime_to_array(dt).into_iter().map(Ok).collect()
}

/// "分解时间"数组 → epoch 秒（按 UTC 解释，与 jq 的 mktime 一致）。
fn mktime<V: ValT>(v: &V) -> ValR<V> {
    let fail = || Error::str("cannot convert this value to time");
    let ts = array_to_datetime(&into_vec(v.clone())?)
        .ok_or_else(fail)?
        .and_then(|dt| dt.to_zoned(TimeZone::UTC))
        .map_err(Error::str)?
        .timestamp();
    timestamp_to_epoch(ts, ts.subsec_nanosecond() > 0)
}

/// 显式时区地把时刻拆成墙钟数组——就是"给定时区的 localtime"。
/// 这条同时也是**内嵌 tzdata 在 wasm 里真的能用**的证明。
fn gmtime_tz<V: ValT>(v: &V, zone: &str) -> ValR<V> {
    let zone = TimeZone::get(zone).map_err(Error::str)?;
    gmtime(v, zone)
}

/// `strftime` 的时区版：同一个格式，但把时刻放到给定时区里格式化（`gmtime_tz` 的文本版）。
fn strftime_tz<V: ValT>(v: &V, fmt: &str, zone: &str) -> ValR<V> {
    let zone = TimeZone::get(zone).map_err(Error::str)?;
    strftime(v, fmt, zone)
}

/// 时间单位 → jiff 的跨度。日历单位（year/quarter/month/week/day）按**墙钟**走，
/// 精确单位（hour/minute/second）按秒走 —— 跨 DST 的一天因此不是 24 小时。
fn unit_span<V: ValT>(unit: &str, amount: i64) -> Result<Span, Error<V>> {
    let span = Span::new();
    let built = match unit {
        "year" => span.try_years(amount),
        "quarter" => span.try_months(amount * 3),
        "month" => span.try_months(amount),
        "week" => span.try_weeks(amount),
        "day" => span.try_days(amount),
        "hour" => span.try_hours(amount),
        "minute" => span.try_minutes(amount),
        "second" => span.try_seconds(amount),
        other => {
            return Err(Error::str(format_args!(
                "{other:?} 不是时间单位：用 year / quarter / month / week / day / hour / minute / second"
            )))
        }
    };
    built.map_err(Error::str)
}

fn zone_of<V: ValT>(zone: &V) -> Result<TimeZone, Error<V>> {
    TimeZone::get(try_str(zone)?).map_err(Error::str)
}

/// 某个单位的**起点**（含）。周从周一起算。
fn start_of_unit<V: ValT>(ts: Timestamp, unit: &str, zone: &TimeZone) -> Result<Timestamp, Error<V>> {
    let zoned = ts.to_zoned(zone.clone());
    let start = match unit {
        "day" => zoned.start_of_day(),
        "week" => {
            let date = zoned.date();
            let back = i64::from(date.weekday().to_monday_zero_offset());
            date.checked_sub(Span::new().try_days(back).map_err(Error::str)?)
                .map_err(Error::str)?
                .to_zoned(zone.clone())
                .map_err(Error::str)?
                .start_of_day()
        }
        "month" => zoned.first_of_month(),
        "quarter" => {
            let month = ((i32::from(zoned.month()) - 1) / 3) * 3 + 1;
            zoned
                .date()
                .with()
                .month(month as i8)
                .day(1)
                .build()
                .map_err(Error::str)?
                .to_zoned(zone.clone())
                .map_err(Error::str)?
                .start_of_day()
        }
        "year" => zoned
            .date()
            .with()
            .month(1)
            .day(1)
            .build()
            .map_err(Error::str)?
            .to_zoned(zone.clone())
            .map_err(Error::str)?
            .start_of_day(),
        other => {
            return Err(Error::str(format_args!(
                "{other:?} 不是对齐单位：用 day / week / month / quarter / year"
            )))
        }
    }
    .map_err(Error::str)?;
    Ok(start.timestamp())
}

/// 加减：日历单位按该时区的墙钟走（跨 DST 的一天不是 24 小时、月末按日历钳制）。
/// 输入输出都是 epoch 秒。
fn tzadd<V: ValT>(v: &V, unit: &str, amount: i64, zone: TimeZone) -> ValR<V> {
    let zoned = epoch_to_timestamp(v)?.to_zoned(zone);
    let after = zoned.checked_add(unit_span::<V>(unit, amount)?).map_err(Error::str)?;
    let ts = after.timestamp();
    timestamp_to_epoch(ts, ts.subsec_nanosecond() > 0)
}

/// 对齐到某个单位的起点（含）：`[tzfloor, tzceil)` 就是那一个区间。
fn tzfloor<V: ValT>(v: &V, unit: &str, zone: TimeZone) -> ValR<V> {
    let ts = start_of_unit::<V>(epoch_to_timestamp(v)?, unit, &zone)?;
    timestamp_to_epoch(ts, false)
}

/// 对齐到**下一个**单位的起点（不含）：先加一个单位，再取那个单位的起点 ——
/// 月末钳制与 DST 都交给上一步，于是"1 月 31 日的下个月"就是 2 月 1 日。
fn tzceil<V: ValT>(v: &V, unit: &str, zone: TimeZone) -> ValR<V> {
    let zoned = epoch_to_timestamp(v)?.to_zoned(zone.clone());
    let next = zoned.checked_add(unit_span::<V>(unit, 1)?).map_err(Error::str)?;
    let ts = start_of_unit::<V>(next.timestamp(), unit, &zone)?;
    timestamp_to_epoch(ts, false)
}

/// 这一组是**纯的**：给定 (值, 格式, 时区) 就有唯一结果。
pub fn funs<D: DataT>() -> Box<[Fun<D>]>
where
    for<'a> D::V<'a>: ValT,
{
    let table: Box<[Filter<RunPtr<D>>]> = Box::new([
        ("fromdateiso8601", v(0), |cv| bome(try_str(&cv.1).and_then(from_iso8601))),
        ("todateiso8601", v(0), |cv| bome(to_iso8601(&cv.1).map(D::V::from))),
        ("strftime", v(1), |cv| unary(cv, |v, fmt| strftime(&v, try_str(&fmt)?, TimeZone::UTC))),
        ("gmtime", v(0), |cv| bome(gmtime(&cv.1, TimeZone::UTC))),
        ("strptime", v(1), |cv| unary(cv, |v, fmt| strptime(try_str(&v)?, try_str(&fmt)?))),
        ("mktime", v(0), |cv| bome(mktime(&cv.1))),
        ("gmtime_tz", v(1), |cv| unary(cv, |v, zone| gmtime_tz(&v, try_str(&zone)?))),
        ("strftime_tz", v(2), |mut cv| {
            let zone = cv.0.pop_var();
            let fmt = cv.0.pop_var();
            bome((|| strftime_tz(&cv.1, try_str(&fmt)?, try_str(&zone)?))())
        }),
        // 日历运算：参数按 LIFO 弹出（先弹最后一个）。
        ("tzadd", v(3), |mut cv| {
            let zone = cv.0.pop_var();
            let amount = cv.0.pop_var();
            let unit = cv.0.pop_var();
            bome((|| {
                let amount = match amount.as_isize() {
                    Some(value) => value as i64,
                    None => return Err(Error::typ(amount, "integer")),
                };
                tzadd(&cv.1, try_str(&unit)?, amount, zone_of(&zone)?)
            })())
        }),
        ("tzfloor", v(2), |mut cv| {
            let zone = cv.0.pop_var();
            let unit = cv.0.pop_var();
            bome((|| tzfloor(&cv.1, try_str(&unit)?, zone_of(&zone)?))())
        }),
        ("tzceil", v(2), |mut cv| {
            let zone = cv.0.pop_var();
            let unit = cv.0.pop_var();
            bome((|| tzceil(&cv.1, try_str(&unit)?, zone_of(&zone)?))())
        }),
    ]);
    table.into_vec().into_iter().map(run).collect()
}

/// 要跟外面打交道的名字：这里没有它们的位置，用到就**明确报错**而不是静默失效。
pub mod forbidden {
    use super::*;
    use jaq_core::Cv;

    const WHY: &str = "在这条求值路上不可用：求值器只依赖「值 + 程序正文」，\
时钟、环境变量与输出通道都在它外面（时间请用 create_time_ctx 落的材料，环境值请当输入传进来）";

    fn refuse<'a, D: DataT>() -> ValXs<'a, D::V<'a>>
    where
        for<'b> D::V<'b>: ValT,
    {
        bome(Err(Error::str(WHY)))
    }

    fn stderr_empty<'a, D: DataT>(_: Cv<'a, D>) -> ValXs<'a, D::V<'a>>
    where
        for<'b> D::V<'b>: ValT,
    {
        refuse::<D>()
    }

    fn debug_empty<'a, D: DataT>(_: Cv<'a, D>) -> ValXs<'a, D::V<'a>>
    where
        for<'b> D::V<'b>: ValT,
    {
        refuse::<D>()
    }

    pub fn funs<D: DataT>() -> Box<[Fun<D>]>
    where
        for<'a> D::V<'a>: ValT,
    {
        let table: Box<[Filter<RunPtr<D>>]> = Box::new([
            ("stderr_empty", v(0), stderr_empty),
            ("debug_empty", v(0), debug_empty),
        ]);
        table.into_vec().into_iter().map(run).collect()
    }
}
