export default function ToolSpinner(props: { size?: number } & any) {
  const { size, ...rest } = props;
  return (
    <svg
      width={size || 24}
      height={size || 24}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <rect fill="currentColor" height="2" rx="2" width="2" x="5" y="16">
        <animate
          attributeName="x"
          dur="1360ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="6;10;10;16;16"
        />
        <animate
          attributeName="y"
          dur="1360ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="16;5;5;16;16"
        />
        <animate
          attributeName="height"
          dur="680ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="2;4;4;2;2"
        />
        <animate
          attributeName="width"
          dur="680ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="2;4;4;2;2"
        />
      </rect>
      <rect fill="currentColor" height="2" rx="2" width="2" x="11" y="6">
        <animate
          attributeName="x"
          dur="1360ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="11;16;16;6;6"
        />
        <animate
          attributeName="y"
          dur="1360ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="7;15;15;16;16"
        />
        <animate
          attributeName="height"
          dur="680ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="2;4;4;2;2"
        />
        <animate
          attributeName="width"
          dur="680ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="2;4;4;2;2"
        />
      </rect>
      <rect fill="currentColor" height="2" rx="2" width="2" x="17" y="16">
        <animate
          attributeName="x"
          dur="1360ms"
          keySplines="0 0.8 0.8 1; 0 0.8 0.8 1; 0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="16;4;4;11;11"
        />
        <animate
          attributeName="y"
          dur="1360ms"
          keySplines="0 0.8 0.8 1; 0 0.8 0.8 1; 0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="16;15;15;7;7"
        />
        <animate
          attributeName="height"
          dur="680ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="2;4;4;2;2"
        />
        <animate
          attributeName="width"
          dur="680ms"
          keySplines="0 0.8 0.8 1"
          keyTimes="0;0.25;0.5;0.75;1"
          repeatCount="indefinite"
          values="2;4;4;2;2"
        />
      </rect>
    </svg>
  );
}
