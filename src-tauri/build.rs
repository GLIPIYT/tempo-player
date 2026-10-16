fn main() {
    let env_path = std::path::Path::new("../.env");
    println!("cargo:rerun-if-changed={}", env_path.display());
    println!("cargo:rerun-if-env-changed=WALLHAVEN_API_KEY");
    println!("cargo:rerun-if-env-changed=TEMPO_SOUNDCLOUD_OAUTH_TOKEN");
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

    let soundcloud_token = match std::env::var("TEMPO_SOUNDCLOUD_OAUTH_TOKEN") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent | std::env::VarError::NotUnicode(_)) => {
            dotenv_value(env_path, "TEMPO_SOUNDCLOUD_OAUTH_TOKEN")
        }
    }
    .unwrap_or_default();
    let generated = format!(
        "pub const BUILTIN_OAUTH_TOKEN: &str = {:?};\n",
        soundcloud_token.trim()
    );
    let out_dir = std::env::var_os("OUT_DIR").expect("Cargo did not set OUT_DIR");
    std::fs::write(
        std::path::PathBuf::from(out_dir).join("soundcloud_session.rs"),
        generated,
    )
    .expect("could not generate SoundCloud session configuration");

    tauri_build::build()
}

fn dotenv_value(path: &std::path::Path, target: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()?
        .lines()
        .find_map(|line| {
            let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
            let (name, value) = line.split_once('=')?;
            if name.trim() != target {
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
}
