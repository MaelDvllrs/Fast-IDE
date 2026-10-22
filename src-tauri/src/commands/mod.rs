//! Couche IPC : commandes Tauri appelées depuis React.
//!
//! Chaque commande reste fine et délègue au module métier correspondant.

pub mod claude;
pub mod fs;
pub mod github;
pub mod scm;
pub mod settings;
pub mod speech;
pub mod system;
pub mod terminal;
pub mod workspace;
