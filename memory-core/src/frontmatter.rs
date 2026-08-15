use std::collections::BTreeMap;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq)]
pub struct FrontMatter {
    pub updated: OffsetDateTime,
    pub by: String,
    pub extra: BTreeMap<String, String>,
}

impl FrontMatter {
    pub fn now(by: &str) -> Self {
        Self {
            updated: OffsetDateTime::now_utc(),
            by: by.to_string(),
            extra: BTreeMap::new(),
        }
    }

    pub fn with(mut self, key: &str, value: &str) -> Self {
        self.extra.insert(key.to_string(), value.to_string());
        self
    }
}

pub fn parse(text: &str) -> (Option<FrontMatter>, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, text);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (None, text);
    };
    let (header, body) = (&rest[..end], &rest[end + 5..]);
    let mut updated = None;
    let mut by = None;
    let mut extra = BTreeMap::new();
    for line in header.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "updated" => updated = OffsetDateTime::parse(v, &Rfc3339).ok(),
            "by" => by = Some(v.to_string()),
            _ => {
                extra.insert(k.to_string(), v.to_string());
            }
        }
    }
    match (updated, by) {
        (Some(updated), Some(by)) => (Some(FrontMatter { updated, by, extra }), body),
        _ => (None, body),
    }
}

pub fn render(fm: &FrontMatter, body: &str) -> String {
    let stamp = fm.updated.replace_nanosecond(0).unwrap_or(fm.updated);
    let mut out = format!(
        "---\nupdated: {}\nby: {}\n",
        stamp.format(&Rfc3339).unwrap_or_default(),
        fm.by
    );
    for (k, v) in &fm.extra {
        out.push_str(&format!("{k}: {v}\n"));
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn round_trips_required_and_extra_keys() {
        let fm = FrontMatter {
            updated: datetime!(2026-08-15 14:32 UTC),
            by: "claude-code".into(),
            extra: BTreeMap::new(),
        }
        .with("branch", "main");
        let text = render(&fm, "# Hello\n");
        assert!(
            text.starts_with(
                "---\nupdated: 2026-08-15T14:32:00Z\nby: claude-code\nbranch: main\n---\n"
            ),
            "{text}"
        );
        let (parsed, body) = parse(&text);
        assert_eq!(parsed.as_ref(), Some(&fm));
        assert_eq!(body, "# Hello\n");
    }

    #[test]
    fn body_without_front_matter_is_returned_whole() {
        let (fm, body) = parse("just text");
        assert!(fm.is_none());
        assert_eq!(body, "just text");
    }

    #[test]
    fn malformed_front_matter_is_ignored_not_fatal() {
        let (fm, body) = parse("---\nupdated: nope\n---\nbody");
        assert!(fm.is_none());
        assert_eq!(body, "body");
    }
}
