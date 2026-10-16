//! Couche IPC : commandes Tauri appelées depuis React.
//!
//! Chaque commande reste fine et délègue au module métier correspondant.

pub mod claude;
pub mod fs;
pub mod settings;
pub mod system;
pub mod terminal;
pub mod workspace;
