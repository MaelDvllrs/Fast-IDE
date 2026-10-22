fn main() {
    // L'icône est intégrée à l'exe à la compilation : on recompile quand elle change
    // (tauri-build ne surveille que sa configuration).
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
