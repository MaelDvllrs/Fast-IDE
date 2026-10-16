import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Affiche l'erreur au lieu de laisser React démonter toute l'interface. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h2>Something went wrong</h2>
        <pre>{error.stack ?? error.message}</pre>
        <button className="primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
