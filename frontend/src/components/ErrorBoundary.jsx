import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Catches render errors so one broken screen does not blank the whole app.
 *
 * Without this, any exception thrown during render unmounts the entire tree and
 * the user gets a white page with no explanation — which is exactly what the
 * customers-page crash produced. A boundary turns that into a contained,
 * readable failure with a way out.
 *
 * Must be a class: there is no hook equivalent of componentDidCatch.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Phase 12 ships this to the backend. Until then the console is the record.
    // eslint-disable-next-line no-console
    console.error('Render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <div className="flex items-center gap-2 text-red-800">
          <AlertTriangle className="h-5 w-5" />
          <h2 className="font-medium">This screen failed to load</h2>
        </div>
        <p className="mt-2 text-sm text-red-700">
          {this.state.error.message ?? 'An unexpected error occurred.'}
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-4 rounded border border-red-300 bg-white px-3 py-1.5 text-sm text-red-800 hover:bg-red-100"
        >
          Try again
        </button>
      </div>
    );
  }
}
