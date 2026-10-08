import { ReactNode } from 'react';

const iconStyles = {
  width: '14px',
  height: '14px',
  viewBox: '0 0 14 14',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
};

// styles that are applied to the ICON svg element
const hoverStyles = {
  opacity: 0,
  transition: 'ease-in-out',
  style: { top: '10.5px' },
};

function Icon({
  children,
  className,
  ...props
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <svg className={className} {...props}>
      {children}
    </svg>
  );
}

type TrafficLightButtonProps = {
  message: 'minimize-app' | 'maximize-app' | 'close-app';
  children: ReactNode;
};

function TrafficLightButton({ message, children }: TrafficLightButtonProps) {
  return (
    <button
      style={{ width: 20, height: 20, position: 'relative' }}
      onClick={() => {
        window.electron.ipcRenderer.sendMessage(message);
      }}
    >
      {children}
    </button>
  );
}

export default function TrafficLights() {
  return (
    <div className="traffic-lights group">
      <TrafficLightButton message="close-app">
        <Icon className="absolute z-0" {...iconStyles}>
          <circle cx="6.3" cy="6.3" r="6.3" fill="#FF4A4A" />
        </Icon>
        <Icon
          className="group-hover:opacity-100 absolute z-1"
          {...iconStyles}
          {...hoverStyles}
        >
          <path
            opacity="0.5"
            d="M6.70432 5.99957L8.85224 3.85634C8.9463 3.76227 8.99915 3.63467 8.99915 3.50163C8.99915 3.36859 8.9463 3.241 8.85224 3.14692C8.75818 3.05285 8.63061 3 8.49759 3C8.36456 3 8.23699 3.05285 8.14293 3.14692L6 5.29515L3.85707 3.14692C3.76301 3.05285 3.63544 3 3.50241 3C3.36939 3 3.24182 3.05285 3.14776 3.14692C3.0537 3.241 3.00085 3.36859 3.00085 3.50163C3.00085 3.63467 3.0537 3.76227 3.14776 3.85634L5.29568 5.99957L3.14776 8.14281C3.10094 8.18925 3.06378 8.24451 3.03842 8.30538C3.01306 8.36626 3 8.43156 3 8.49752C3 8.56347 3.01306 8.62877 3.03842 8.68965C3.06378 8.75052 3.10094 8.80578 3.14776 8.85222C3.19419 8.89905 3.24944 8.93622 3.31031 8.96158C3.37118 8.98694 3.43647 9 3.50241 9C3.56836 9 3.63365 8.98694 3.69452 8.96158C3.75539 8.93622 3.81063 8.89905 3.85707 8.85222L6 6.70399L8.14293 8.85222C8.18937 8.89905 8.24461 8.93622 8.30548 8.96158C8.36635 8.98694 8.43164 9 8.49759 9C8.56353 9 8.62882 8.98694 8.68969 8.96158C8.75056 8.93622 8.80581 8.89905 8.85224 8.85222C8.89906 8.80578 8.93622 8.75052 8.96158 8.68965C8.98694 8.62877 9 8.56347 9 8.49752C9 8.43156 8.98694 8.36626 8.96158 8.30538C8.93622 8.24451 8.89906 8.18925 8.85224 8.14281L6.70432 5.99957Z"
            fill="black"
          />
        </Icon>
      </TrafficLightButton>
      <TrafficLightButton message="minimize-app">
        <Icon className="absolute z-0" {...iconStyles}>
          <circle cx="6.3" cy="6.3" r="6.3" fill="#FFB83D" />
        </Icon>
        <Icon
          className="group-hover:opacity-100 absolute z-1"
          {...iconStyles}
          {...hoverStyles}
        >
          <path
            opacity="0.5"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M2 5.7C2 5.3134 2.35817 5 2.8 5H9.2C9.64183 5 10 5.3134 10 5.7C10 6.0866 9.64183 6.4 9.2 6.4H2.8C2.35817 6.4 2 6.0866 2 5.7Z"
            fill="black"
          />
        </Icon>
      </TrafficLightButton>
      <TrafficLightButton message="maximize-app">
        <Icon className="absolute z-0" {...iconStyles}>
          <circle cx="6.3" cy="6.3" r="6.3" fill="#00C543" />
        </Icon>
        <Icon
          className="group-hover:opacity-100 absolute z-1"
          {...iconStyles}
          {...hoverStyles}
        >
          <g opacity="0.5">
            <path
              d="M7.90909 3L3 7.90909V4C3 3.44772 3.44772 3 4 3H7.90909Z"
              fill="black"
            />
            <path
              d="M4.09091 9L9 4.09091L9 8C9 8.55228 8.55228 9 8 9L4.09091 9Z"
              fill="black"
            />
          </g>
        </Icon>
      </TrafficLightButton>
    </div>
  );
}
