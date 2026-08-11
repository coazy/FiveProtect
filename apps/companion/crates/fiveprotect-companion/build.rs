//! Compiles the scan engine into the companion.
//!
//! The engine also has a CMake build, which is what CI uses to hold it to `/W4 /WX` and to
//! run its own tests. This one exists so that `cargo build` produces a working binary
//! without a second build system in the loop — the same sources, compiled again, linked
//! statically so there is one file to sign and no separate library an attacker could swap.

use std::path::{Path, PathBuf};

fn main() {
    // `env!` rather than `std::env::var`: cargo sets this while compiling the build script
    // too, so the path is resolved at compile time and there is no runtime failure to handle.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // apps/companion/crates/fiveprotect-companion → repository root
    let root = manifest
        .ancestors()
        .nth(4)
        .unwrap_or(Path::new("."))
        .to_path_buf();

    let native = root.join("apps/companion/native");
    let protocol = root.join("packages/protocol");

    let sources = [
        native.join("src/probes.cpp"),
        native.join("src/windows_source.cpp"),
        native.join("src/abi.cpp"),
    ];

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++20")
        .include(native.join("include"))
        .include(protocol.join("cpp/include"))
        .include(protocol.join("generated/cpp"));

    if cfg!(target_env = "msvc") {
        build.flag("/utf-8").flag("/permissive-").flag("/W4");
    } else {
        build.flag("-Wall").flag("-Wextra");
    }

    if cfg!(windows) {
        build
            .define("WIN32_LEAN_AND_MEAN", None)
            .define("NOMINMAX", None)
            .define("UNICODE", None)
            .define("_UNICODE", None);
    }

    for source in &sources {
        println!("cargo:rerun-if-changed={}", source.display());
        build.file(source);
    }

    for header in [
        native.join("include/fiveprotect/engine_abi.h"),
        native.join("include/fiveprotect/probes.hpp"),
        native.join("include/fiveprotect/windows_source.hpp"),
        protocol.join("generated/cpp/fiveprotect_protocol.hpp"),
        protocol.join("cpp/include/fiveprotect_json.hpp"),
    ] {
        println!("cargo:rerun-if-changed={}", header.display());
    }

    build.compile("fiveprotect_scan");

    if cfg!(windows) {
        // tbs for the TPM base services, user32 for the window enumeration that tells a
        // running game from a headless one, advapi32 for the registry probes. CMake links
        // the last one through its default library set; cargo links nothing it is not told
        // about, so it is named here.
        println!("cargo:rustc-link-lib=dylib=tbs");
        println!("cargo:rustc-link-lib=dylib=user32");
        println!("cargo:rustc-link-lib=dylib=advapi32");
    }
}
