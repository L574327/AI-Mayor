import { useNavigate } from 'react-router-dom';

export default function useNav() {
  const navigate = useNavigate();
  return (path: string) => {
    navigate(path);
    window.electron.ingestEvent([{ navigation: path }]);
  };
}
