import * as React from 'react';

const useLazyEffect: typeof React.useEffect = (cb, dep) => {
  const initializeRef = React.useRef<boolean>(false);

  React.useEffect((...args) => {
    if (initializeRef.current) {
      cb(...args);
    } else {
      initializeRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dep);
};

export default useLazyEffect;
