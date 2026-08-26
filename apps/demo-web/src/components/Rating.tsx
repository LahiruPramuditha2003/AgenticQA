import React from 'react';

interface RatingProps {
  value: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;
  interactive?: boolean;
  onChange?: (value: number) => void;
}

export const Rating: React.FC<RatingProps> = ({
  value,
  max = 5,
  size = 'md',
  showValue = false,
  interactive = false,
  onChange,
}) => {
  const [hoverValue, setHoverValue] = React.useState<number | null>(null);

  const displayValue = hoverValue !== null ? hoverValue : value;

  const handleClick = (newValue: number) => {
    if (interactive && onChange) {
      onChange(newValue);
    }
  };

  return (
    <div className={`rating rating-${size}`}>
      <div className="rating-stars">
        {[...Array(max)].map((_, index) => {
          const starValue = index + 1;
          const isFilled = starValue <= displayValue;
          const isHalf = !isFilled && starValue - 0.5 <= displayValue;

          return (
            <span
              key={index}
              className={`star ${isFilled ? 'star-filled' : ''} ${isHalf ? 'star-half' : ''} ${interactive ? 'star-interactive' : ''}`}
              onClick={() => handleClick(starValue)}
              onMouseEnter={() => interactive && setHoverValue(starValue)}
              onMouseLeave={() => interactive && setHoverValue(null)}
            >
              {isFilled || isHalf ? '★' : '☆'}
            </span>
          );
        })}
      </div>
      {showValue && <span className="rating-value">{value.toFixed(1)}</span>}
    </div>
  );
};
