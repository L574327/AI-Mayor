import { useState, useEffect, lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { IAppConfig } from './types';
import apps from './index';

const APPS: Record<
  string,
  React.LazyExoticComponent<() => React.ReactElement>
> = apps.reduce(
  (
    acc: Record<string, React.LazyExoticComponent<() => React.ReactElement>>,
    app: IAppConfig,
  ) => {
    acc[app.key] = lazy(() => import(`./${app.key}/App`));
    return acc;
  },
  {},
);

const NotFound = lazy(() => import('./NotFound'));

export default function Loader() {
  const { key } = useParams();
  const [app, setApp] = useState<React.ReactElement>(<NotFound />);

  useEffect(() => {
    const importApp = async () => {
      const config: IAppConfig | undefined = apps.find(
        (app: IAppConfig) => app.key === key,
      );
      if (!config || !config.isEnabled) {
        setApp(<NotFound />);
        return;
      }
      const App = APPS[config.key] || NotFound;
      setApp(<App />);
    };
    importApp();
  }, [key]);

  return (
    <div id="app-container" className="h-full">
      <Suspense fallback={<div>Loading...</div>}>{app}</Suspense>
    </div>
  );
}
