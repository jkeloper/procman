import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[procman] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
          <div className="max-w-md space-y-4 text-center">
            <div className="text-[48px]">⚠️</div>
            <h1 className="text-[20px] font-bold text-foreground">Something went wrong</h1>
            <p className="text-[13px] text-muted-foreground">
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
            <pre className="max-h-40 overflow-auto rounded-lg bg-muted/30 p-3 text-left font-mono text-[11px] text-muted-foreground">
              {this.state.error?.stack?.slice(0, 500)}
            </pre>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="rounded-lg bg-primary px-6 py-2 text-[14px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Reload procman
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
