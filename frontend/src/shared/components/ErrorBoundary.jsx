import * as React from 'react'
import { ErrorState } from './ErrorState'

/**
 * Top-level safety net. Catches render errors in any child and shows a
 * friendly error state instead of a blank screen.
 *
 * Reset key prop: change it (e.g. to current pathname) and the boundary
 * re-attempts render — useful so navigating away from a broken page works.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Hook for telemetry once we have one. Console for now so devs see it.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6">
          <ErrorState
            title="화면을 그릴 수 없습니다"
            description={this.state.error?.message ?? '알 수 없는 오류'}
            onRetry={() => this.setState({ error: null })}
            retryLabel="다시 시도"
          />
        </div>
      )
    }
    return this.props.children
  }
}
