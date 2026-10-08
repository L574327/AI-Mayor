import { forwardRef } from 'react';
import './Spinner.scss';

function Spinner(
  {
    size = 24,
    className = '',
  }: {
    size?: number;
    className?: string;
  },
  ref: any,
) {
  return (
    <div
      className={`spinner ${className}`}
      ref={ref}
      style={{ width: size, height: size }}
    >
      <div style={{ width: size, height: size }} />
      <div style={{ width: size, height: size }} />
      <div style={{ width: size, height: size }} />
      <div style={{ width: size, height: size }} />
    </div>
  );
}
export default forwardRef(Spinner);
