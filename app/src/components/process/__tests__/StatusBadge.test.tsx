import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../StatusBadge';

describe('StatusBadge', () => {
  it('renders "running" with emerald dot when status is running', () => {
    const { container } = render(<StatusBadge status="running" />);
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      'Process status: running',
    );
    expect(screen.getByRole('status')).toHaveTextContent('running');
    // The color class is applied to the inner dot.
    expect(container.querySelector('.bg-emerald-500')).not.toBeNull();
  });

  it('renders "crashed" with red dot when status is crashed', () => {
    const { container } = render(<StatusBadge status="crashed" />);
    expect(screen.getByRole('status')).toHaveTextContent('crashed');
    expect(container.querySelector('.bg-red-500')).not.toBeNull();
  });

  it('renders "idle" with muted dot when status is stopped', () => {
    render(<StatusBadge status="stopped" />);
    expect(screen.getByRole('status')).toHaveTextContent('idle');
  });

  it('defaults to "idle" when status is undefined', () => {
    render(<StatusBadge status={undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('idle');
  });

  it('applies pulse animation only for running', () => {
    const { container, rerender } = render(<StatusBadge status="running" />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    rerender(<StatusBadge status="stopped" />);
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});
