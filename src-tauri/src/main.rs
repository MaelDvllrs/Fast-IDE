// Évite l'ouverture d'une console en plus de la fenêtre sous Windows (release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fast_lib::run()
}
