//! Builds the Anchor IDL without the Anchor CLI:
//!   cargo run --release --manifest-path tools/idlgen/Cargo.toml -- programs/oar-registry > idl/oar_registry.json
fn main() {
    // anchor-lang-idl 0.1.4 passes a literal "+{toolchain}" to cargo when this is set (as `cargo run` does).
    std::env::remove_var("RUSTUP_TOOLCHAIN");
    let path = std::env::args().nth(1).expect("usage: idlgen <program-path>");
    let idl = anchor_lang_idl::build::IdlBuilder::new()
        .program_path(std::fs::canonicalize(path).expect("program path").into())
        .resolution(true)
        .build()
        .expect("IDL build failed");
    println!("{}", serde_json::to_string_pretty(&idl).unwrap());
}
