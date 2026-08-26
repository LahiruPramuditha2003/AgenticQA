import React, { type InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, icon, className = '', id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className={`input-group ${className}`}>
        {label && (
          <label htmlFor={inputId} className="input-label">
            {label}
          </label>
        )}
        <div className="input-wrapper">
          {icon && <span className="input-icon">{icon}</span>}
          <input
            ref={ref}
            id={inputId}
            className={`input ${icon ? 'input-with-icon' : ''} ${error ? 'input-error' : ''}`}
            {...props}
          />
        </div>
        {error && <span className="input-error-message">{error}</span>}
        {helperText && !error && <span className="input-helper">{helperText}</span>}
      </div>
    );
  }
);

Input.displayName = 'Input';
