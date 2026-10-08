import useNav from 'hooks/useNav';
import { useEffect, useState } from 'react';
import ToolInstallDialog from 'renderer/pages/tool/InstallDialog';
import { IMCPServer } from 'types/mcp';

export default function ToolSetup() {
  const navigate = useNav();
  const [mcpServer, setMcpServer] = useState<IMCPServer>();
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  useEffect(() => {
    window.electron.ipcRenderer.on('install-tool', async (data: any) => {
      navigate('/tool');
      const server = {
        name: data.name,
        isActive: false,
        description: data.description,
      } as any;
      if (data.url) {
        server.url = data.url;
        if (data.headers) {
          server.headers = data.headers;
        }
      } else {
        server.command = data.command;
        if (data.args) {
          server.args = data.args;
        }
        if (data.env) {
          server.env = data.env;
        }
      }
      setMcpServer(server);
      setInstallDialogOpen(true);
    });
    window.electron.ipcRenderer.sendMessage('install-tool-listener-ready');

    return () => {
      window.electron.ipcRenderer.unsubscribeAll('install-tool');
    };
  }, []);

  return mcpServer ? (
    <ToolInstallDialog
      server={mcpServer as IMCPServer}
      open={installDialogOpen}
      setOpen={setInstallDialogOpen}
    />
  ) : null;
}
