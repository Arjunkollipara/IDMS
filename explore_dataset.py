from __future__ import annotations

import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import pandas as pd


REPORT_FILE = "dataset_report.txt"


def find_dataset_path() -> Path:
    env_path = os.getenv("DATASET_PATH")
    if env_path:
        candidate = Path(env_path).expanduser().resolve()
        if candidate.exists() and candidate.is_file():
            return candidate
        raise FileNotFoundError(f"DATASET_PATH is set but file was not found: {candidate}")

    csv_files = sorted(Path.cwd().glob("*.csv"))
    if csv_files:
        return csv_files[0].resolve()

    raise FileNotFoundError("No CSV file found in the current directory and DATASET_PATH is not set.")


def is_missing(value: Any) -> bool:
    return value is None or (isinstance(value, float) and pd.isna(value)) or pd.isna(value)


def normalize_text(value: Any) -> str | None:
    if is_missing(value):
        return None
    text = str(value).strip()
    return text if text != "" else None


def parse_bool(value: Any) -> bool | None:
    text = normalize_text(value)
    if text is None:
        return None
    lowered = text.lower()
    if lowered in {"true", "t", "1", "yes", "y"}:
        return True
    if lowered in {"false", "f", "0", "no", "n"}:
        return False
    return None


def parse_numeric(value: Any) -> float | None:
    text = normalize_text(value)
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_datetime(value: Any) -> pd.Timestamp | None:
    text = normalize_text(value)
    if text is None:
        return None
    parsed = pd.to_datetime(text, errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed


def format_value(value: Any) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.isoformat(sep=" ")
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return str(value)


def infer_column_type(series: pd.Series) -> str:
    values = [v for v in series.tolist() if normalize_text(v) is not None]
    if not values:
        return "empty"

    bool_hits = sum(parse_bool(v) is not None for v in values)
    num_hits = sum(parse_numeric(v) is not None for v in values)
    dt_hits = sum(parse_datetime(v) is not None for v in values)
    total = len(values)

    if bool_hits == total:
        return "boolean"
    if num_hits == total:
        return "numeric"
    if dt_hits == total:
        return "datetime"
    if num_hits / total >= 0.9:
        return "numeric-like"
    if dt_hits / total >= 0.9:
        return "datetime-like"
    if bool_hits / total >= 0.9:
        return "boolean-like"
    return "string"


def count_values(series: pd.Series) -> list[tuple[str, int]]:
    counts = Counter(normalize_text(v) for v in series.tolist() if normalize_text(v) is not None)
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))


def section(title: str) -> list[str]:
    return ["", "=" * 80, title, "=" * 80]


def summarize_numeric(series: pd.Series) -> dict[str, Any]:
    numeric = pd.to_numeric(series, errors="coerce")
    non_null = numeric.dropna()
    return {
        "min": None if non_null.empty else float(non_null.min()),
        "max": None if non_null.empty else float(non_null.max()),
        "mean": None if non_null.empty else float(non_null.mean()),
        "median": None if non_null.empty else float(non_null.median()),
        "nulls": int(numeric.isna().sum()),
        "zeros": int((numeric == 0).sum()),
    }


def summarize_dates(series: pd.Series, now: pd.Timestamp) -> dict[str, Any]:
    parsed = pd.to_datetime(series, errors="coerce")
    non_null = parsed.dropna()
    return {
        "non_null": int(parsed.notna().sum()),
        "null": int(parsed.isna().sum()),
        "earliest": None if non_null.empty else non_null.min(),
        "latest": None if non_null.empty else non_null.max(),
        "parsed": parsed,
        "past": None,
        "next_7": None,
        "next_30": None,
    }


def append_key_value(lines: list[str], key: str, value: Any, indent: int = 2) -> None:
    lines.append(f"{' ' * indent}{key}: {value}")


def rows_to_text(df: pd.DataFrame) -> str:
    if df.empty:
        return "(no rows)"
    return df.to_string(index=False)


def bucket_calls_to_donations_ratio(value: Any) -> str:
    ratio = parse_numeric(value)
    if ratio is None:
        return "NULL"
    if ratio == 0.0:
        return "0.0"
    if 0.01 <= ratio <= 0.3:
        return "0.01 to 0.3"
    if 0.31 <= ratio <= 0.6:
        return "0.31 to 0.6"
    if 0.61 <= ratio <= 0.9:
        return "0.61 to 0.9"
    if 0.91 <= ratio <= 1.0:
        return "0.91 to 1.0"
    if ratio > 1.0:
        return "> 1.0"
    return "other"


def approximate_city(lat: Any, lng: Any) -> str:
    lat_val = parse_numeric(lat)
    lng_val = parse_numeric(lng)
    if lat_val is None or lng_val is None:
        return "NULL"

    if 17.2 <= lat_val <= 17.6 and 78.3 <= lng_val <= 78.6:
        return "Hyderabad"
    if 18.8 <= lat_val <= 19.3 and 72.7 <= lng_val <= 73.0:
        return "Mumbai"
    if 28.4 <= lat_val <= 28.8 and 76.8 <= lng_val <= 77.4:
        return "Delhi"
    if 12.8 <= lat_val <= 13.1 and 77.4 <= lng_val <= 77.8:
        return "Bangalore"
    return "Other"


def build_report(df: pd.DataFrame, dataset_path: Path) -> list[str]:
    lines: list[str] = []
    now = pd.Timestamp(datetime.now())

    lines.append("IDMS Dataset Report")
    lines.append(f"Source file: {dataset_path}")
    lines.append(f"Generated at: {datetime.now().isoformat(sep=' ', timespec='seconds')}")

    lines.extend(section("SECTION 1 - Basic Shape"))
    append_key_value(lines, "Total rows", len(df))
    append_key_value(lines, "Total columns", len(df.columns))
    append_key_value(lines, "Column names", ", ".join(df.columns.tolist()))
    lines.append("  Inferred data type for each column:")
    for column in df.columns:
        append_key_value(lines, column, infer_column_type(df[column]), indent=4)

    lines.extend(section("SECTION 2 - Role Analysis"))
    for column in ["role", "donor_type", "role_status", "status", "user_donation_active_status"]:
        lines.append(f"  {column}:")
        for value, count in count_values(df[column]):
            append_key_value(lines, repr(value), count, indent=4)

    lines.extend(section("SECTION 3 - Bridge Analysis"))
    bridge_not_null = int(df["bridge_id"].notna().sum())
    bridge_null = int(df["bridge_id"].isna().sum())
    unique_bridge_ids = df["bridge_id"].dropna().astype(str).str.strip()
    unique_bridge_ids = unique_bridge_ids[unique_bridge_ids != ""]
    donor_bridge_mask = (
        df["bridge_id"].notna()
        & (df["bridge_id"].astype(str).str.strip() != "")
        & df["role"].astype(str).str.contains("donor", case=False, na=False)
    )
    donor_bridge_counts = df.loc[donor_bridge_mask, "bridge_id"].astype(str).str.strip().value_counts()
    append_key_value(lines, "Total rows where bridge_id is NOT NULL", bridge_not_null)
    append_key_value(lines, "Total rows where bridge_id is NULL", bridge_null)
    append_key_value(lines, "Total unique bridge_ids", int(unique_bridge_ids.nunique()))
    if donor_bridge_counts.empty:
        append_key_value(lines, "Donors per bridge_id (min)", 0)
        append_key_value(lines, "Donors per bridge_id (max)", 0)
        append_key_value(lines, "Donors per bridge_id (average)", 0)
        append_key_value(lines, "Donors per bridge_id (median)", 0)
    else:
        append_key_value(lines, "Donors per bridge_id (min)", float(donor_bridge_counts.min()))
        append_key_value(lines, "Donors per bridge_id (max)", float(donor_bridge_counts.max()))
        append_key_value(lines, "Donors per bridge_id (average)", float(donor_bridge_counts.mean()))
        append_key_value(lines, "Donors per bridge_id (median)", float(donor_bridge_counts.median()))
    lines.append("  Top 5 bridge_ids by donor count:")
    for bridge_id, count in donor_bridge_counts.head(5).items():
        append_key_value(lines, bridge_id, int(count), indent=4)
    append_key_value(lines, "Bridges with only 1 donor", int((donor_bridge_counts == 1).sum()))
    append_key_value(lines, "Bridges with 8 or more donors", int((donor_bridge_counts >= 8).sum()))

    lines.extend(section("SECTION 4 - Blood Group Analysis"))
    for column in ["blood_group", "bridge_blood_group"]:
        lines.append(f"  {column}:")
        for value, count in count_values(df[column]):
            append_key_value(lines, repr(value), count, indent=4)
    blood_group = df["blood_group"].astype(str).str.strip().replace({"nan": ""})
    bridge_blood_group = df["bridge_blood_group"].astype(str).str.strip().replace({"nan": ""})
    mismatch_mask = (
        blood_group.ne("")
        & bridge_blood_group.ne("")
        & blood_group.str.lower().ne(bridge_blood_group.str.lower())
    )
    append_key_value(lines, "Rows where blood_group mismatches bridge_blood_group", int(mismatch_mask.sum()))

    lines.extend(section("SECTION 5 - Date Field Analysis"))
    date_columns = [
        "last_transfusion_date",
        "expected_next_transfusion_date",
        "last_donation_date",
        "next_eligible_date",
        "last_bridge_donation_date",
        "registration_date",
        "last_contacted_date",
    ]
    for column in date_columns:
        lines.append(f"  {column}:")
        parsed = pd.to_datetime(df[column], errors="coerce")
        non_null = parsed.dropna()
        append_key_value(lines, "Non-null values", int(parsed.notna().sum()), indent=4)
        append_key_value(lines, "Null values", int(parsed.isna().sum()), indent=4)
        append_key_value(lines, "Earliest date", None if non_null.empty else non_null.min(), indent=4)
        append_key_value(lines, "Latest date", None if non_null.empty else non_null.max(), indent=4)
        if column == "expected_next_transfusion_date":
            append_key_value(lines, "Values in the past", int((parsed.notna() & (parsed < now)).sum()), indent=4)
            append_key_value(lines, "Values in the next 7 days", int((parsed.notna() & (parsed >= now) & (parsed <= now + pd.Timedelta(days=7))).sum()), indent=4)
            append_key_value(lines, "Values in the next 30 days", int((parsed.notna() & (parsed >= now) & (parsed <= now + pd.Timedelta(days=30))).sum()), indent=4)

    lines.extend(section("SECTION 6 - Numeric Field Analysis"))
    numeric_columns = [
        "donations_till_date",
        "total_calls",
        "frequency_in_days",
        "calls_to_donations_ratio",
        "quantity_required",
        "cycle_of_donations",
    ]
    for column in numeric_columns:
        lines.append(f"  {column}:")
        summary = summarize_numeric(df[column])
        append_key_value(lines, "Min", summary["min"], indent=4)
        append_key_value(lines, "Max", summary["max"], indent=4)
        append_key_value(lines, "Mean", summary["mean"], indent=4)
        append_key_value(lines, "Median", summary["median"], indent=4)
        append_key_value(lines, "Nulls", summary["nulls"], indent=4)
        append_key_value(lines, "Zeros", summary["zeros"], indent=4)

    lines.extend(section("SECTION 7 - Location Analysis"))
    lat_non_null = int(df["latitude"].notna().sum())
    lng_non_null = int(df["longitude"].notna().sum())
    both_null = int((df["latitude"].isna() & df["longitude"].isna()).sum())
    append_key_value(lines, "Rows where latitude is NOT NULL", lat_non_null)
    append_key_value(lines, "Rows where longitude is NOT NULL", lng_non_null)
    append_key_value(lines, "Rows where both are NULL", both_null)
    city_counts = Counter()
    for lat, lng in zip(df["latitude"], df["longitude"]):
        city_counts[approximate_city(lat, lng)] += 1
    lines.append("  Approximate city distribution:")
    for city in ["Hyderabad", "Mumbai", "Delhi", "Bangalore", "Other", "NULL"]:
        append_key_value(lines, city, int(city_counts.get(city, 0)), indent=4)

    lines.extend(section("SECTION 8 - Donor Reliability Signals"))
    ratio_buckets = Counter(bucket_calls_to_donations_ratio(value) for value in df["calls_to_donations_ratio"])
    lines.append("  calls_to_donations_ratio buckets:")
    for bucket in ["0.0", "0.01 to 0.3", "0.31 to 0.6", "0.61 to 0.9", "0.91 to 1.0", "NULL", "> 1.0", "other"]:
        if bucket in ratio_buckets:
            append_key_value(lines, bucket, int(ratio_buckets[bucket]), indent=4)
    donated_earlier = Counter(
        "null" if parse_bool(value) is None else str(parse_bool(value)).lower()
        for value in df["donated_earlier"]
    )
    append_key_value(lines, "donated_earlier = true", int(donated_earlier.get("true", 0)))
    append_key_value(lines, "donated_earlier = false", int(donated_earlier.get("false", 0)))
    append_key_value(lines, "donated_earlier = null", int(donated_earlier.get("null", 0)))
    lines.append("  inactive_trigger_comment unique values:")
    for value, count in count_values(df["inactive_trigger_comment"]):
        append_key_value(lines, repr(value), count, indent=4)

    lines.extend(section("SECTION 9 - Data Quality Issues"))
    null_ratios = df.isna().mean()
    over_50 = [column for column, ratio in null_ratios.items() if ratio > 0.5]
    over_90 = [column for column, ratio in null_ratios.items() if ratio > 0.9]
    append_key_value(lines, "Columns with more than 50% null values", ", ".join(over_50) if over_50 else "None")
    append_key_value(lines, "Columns with more than 90% null values", ", ".join(over_90) if over_90 else "None")
    duplicate_user_ids = df["user_id"].astype(str).str.strip()
    duplicate_user_ids = duplicate_user_ids[duplicate_user_ids != ""]
    dup_counts = duplicate_user_ids[duplicate_user_ids.duplicated(keep=False)].value_counts()
    append_key_value(lines, "Any user_id duplicates", int(dup_counts.sum() > 0))
    if dup_counts.empty:
        append_key_value(lines, "Duplicate user_ids found", "None")
    else:
        for user_id, count in dup_counts.items():
            append_key_value(lines, user_id, int(count), indent=4)

    bridge_roles = df[df["bridge_id"].notna() & (df["bridge_id"].astype(str).str.strip() != "")].copy()
    bridge_roles["role_clean"] = bridge_roles["role"].astype(str).str.strip().str.lower()
    bridge_mixed = {}
    for bridge_id, group in bridge_roles.groupby("bridge_id"):
        has_donor = group["role_clean"].str.contains("donor", na=False).any()
        has_other = (~group["role_clean"].str.contains("donor", na=False)).any()
        if has_donor and has_other:
            bridge_mixed[bridge_id] = len(group)
    append_key_value(lines, "bridge_id values that appear as both a donor and something else", len(bridge_mixed))
    if bridge_mixed:
        for bridge_id, count in sorted(bridge_mixed.items(), key=lambda item: (-item[1], str(item[0]))):
            append_key_value(lines, bridge_id, count, indent=4)

    next_eligible = pd.to_datetime(df["next_eligible_date"], errors="coerce")
    last_donation = pd.to_datetime(df["last_donation_date"], errors="coerce")
    transfer_error_mask = next_eligible.notna() & last_donation.notna() & (next_eligible < last_donation)
    append_key_value(lines, "Rows where next_eligible_date is before last_donation_date", int(transfer_error_mask.sum()))

    expected_next = pd.to_datetime(df["expected_next_transfusion_date"], errors="coerce")
    last_transfusion = pd.to_datetime(df["last_transfusion_date"], errors="coerce")
    transfusion_error_mask = expected_next.notna() & last_transfusion.notna() & (expected_next < last_transfusion)
    append_key_value(lines, "Rows where expected_next_transfusion_date is before last_transfusion_date", int(transfusion_error_mask.sum()))

    lines.extend(section("SECTION 10 - Sample Rows"))
    bridge_rows = df[df["bridge_id"].notna() & (df["bridge_id"].astype(str).str.strip() != "")]
    null_bridge_rows = df[df["bridge_id"].isna() | (df["bridge_id"].astype(str).str.strip() == "")]
    lines.append("  3 rows where bridge_id is NOT NULL:")
    lines.append(rows_to_text(bridge_rows.head(3)))
    lines.append("")
    lines.append("  3 rows where bridge_id is NULL:")
    lines.append(rows_to_text(null_bridge_rows.head(3)))
    lines.append("")
    if "donations_till_date" in df.columns:
        donor_count_numeric = pd.to_numeric(df["donations_till_date"], errors="coerce")
        highest_donations_idx = donor_count_numeric.idxmax() if donor_count_numeric.notna().any() else None
        lines.append("  Row with the highest donations_till_date:")
        lines.append(rows_to_text(df.loc[[highest_donations_idx]]) if highest_donations_idx is not None else "(no rows)")
        lines.append("")
    ratio_numeric = pd.to_numeric(df["calls_to_donations_ratio"], errors="coerce")
    highest_ratio_idx = ratio_numeric.idxmax() if ratio_numeric.notna().any() else None
    lines.append("  Row with the highest calls_to_donations_ratio:")
    lines.append(rows_to_text(df.loc[[highest_ratio_idx]]) if highest_ratio_idx is not None else "(no rows)")

    return lines


def summarize_in_plain_english(df: pd.DataFrame) -> str:
    total_rows = len(df)
    bridge_rows = int(df["bridge_id"].notna().sum())
    patient_rows = int(df["role"].astype(str).str.contains("patient", case=False, na=False).sum())
    donor_rows = int(df["role"].astype(str).str.contains("donor", case=False, na=False).sum())
    bridge_ids = int(df["bridge_id"].dropna().astype(str).str.strip().replace("", pd.NA).dropna().nunique())
    return (
        f"This dataset looks like a large operational blood-donation and patient-support table with {total_rows:,} rows, "
        f"covering donors, bridge donors, emergency donors, patients, and chain relationships across {bridge_ids:,} bridge IDs. "
        f"It can support matching, prioritization, chain analysis, donor reliability scoring, and basic data-quality checks, "
        f"but it cannot by itself prove medical eligibility, real-time availability, or the full context behind why a donor or patient was recorded without additional business rules and external validation."
    )


def main() -> None:
    dataset_path = find_dataset_path()
    df = pd.read_csv(dataset_path, dtype=str, keep_default_na=False)
    df = df.replace({"": pd.NA})

    report_lines = build_report(df, dataset_path)
    summary = summarize_in_plain_english(df)
    report_lines.extend(["", "=" * 80, "SUMMARY", "=" * 80, summary])

    report_text = "\n".join(report_lines)
    print(report_text)
    Path(REPORT_FILE).write_text(report_text, encoding="utf-8")


if __name__ == "__main__":
    main()
