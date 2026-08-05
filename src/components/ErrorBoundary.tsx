import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-fallback" role="alert">
        <h2>Something went wrong.</h2>
        <p>The app hit an unexpected error. Reloading usually fixes it.</p>
        <button className="pill-accent" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
