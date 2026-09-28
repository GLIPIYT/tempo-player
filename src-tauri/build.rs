fn main() {
    let env_path = std::path::Path::new("../.env");
    println!("cargo:rerun-if-changed={}", env_path.display());
    println!("cargo:rerun-if-env-changed=WALLHAVEN_API_KEY");
    // Local .env keeps credentials out of Git, not out of a shipped binary.
    // Environment variables supplied by CI take precedence over the local file.
    let key = std::env::var("WALLHAVEN_API_KEY").ok().or_else(|| {
        std::fs::read_to_string(env_path).ok().and_then(|content| {
            content.lines().find_map(|line| {
                let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
                let (name, value) = line.split_once('=')?;
                if name.trim() != "WALLHAVEN_API_KEY" {
                    return None;
                }
                let value = value.trim();
                let value = if value.len() >= 2
                    && ((value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\'')))
                {
                    &value[1..value.len() - 1]
                } else {
                    value.split(" #").next().unwrap_or_default().trim()
                };
                Some(value.to_owned())
            })
        })
    });
    let key = key.unwrap_or_default();
    // Reject line breaks so local input cannot emit another Cargo directive.
    let key = if key.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        key
    } else {
        String::new()
    };
    println!("cargo:rustc-env=TEMPO_WALLHAVEN_API_KEY={key}");
    tauri_build::build()
}
