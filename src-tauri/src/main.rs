// Évite l'ouverture d'une console en plus de la fenêtre sous Windows (release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vibe_ide_lib::run()
}
