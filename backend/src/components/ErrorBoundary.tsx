import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled render error:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="max-w-md w-full sb-card p-8 text-center flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-[22px] bg-danger-soft text-danger-ink flex items-center justify-center">
              <AlertTriangle className="w-8 h-8" />
            </div>
            <h2 className="sb-display text-[30px]">This screen tripped up</h2>
            <p className="text-[14px] text-muted">
              Something on the dashboard failed to draw. The detector on the server is still running.
            </p>
            {this.state.error && (
              <pre className="w-full text-left text-[12px] bg-surface p-3 rounded-[14px] overflow-x-auto text-danger-ink font-mono max-h-32">
                {this.state.error.message}
              </pre>
            )}
            <button type="button" onClick={this.handleReset} className="sb-btn sb-btn-primary w-full">
              <RefreshCw className="w-4 h-4" />
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
