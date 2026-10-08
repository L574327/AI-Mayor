import React, { createContext, useContext, useEffect, useRef } from 'react';

/**
 * Function type for handling context menu commands
 * @param command - The command string to execute
 * @param params - Parameters associated with the command
 */
type ContextMenuHandler = (command: string, params: any) => void;

/**
 * Interface defining the context menu management operations
 */
interface ContextMenuManager {
  /**
   * Registers a handler for context menu commands
   * @param type - The type identifier for the handler
   * @param id - The unique identifier for the handler
   * @param handler - The function to handle context menu commands
   */
  registerHandler: (
    type: string,
    id: string,
    handler: ContextMenuHandler,
  ) => void;
  /**
   * Removes a registered handler
   * @param type - The type identifier for the handler
   * @param id - The unique identifier for the handler
   */
  unregisterHandler: (type: string, id: string) => void;
}

/**
 * React context for managing context menu handlers
 */
const ContextMenuContext = createContext<ContextMenuManager>({
  registerHandler: () => {},
  unregisterHandler: () => {},
});

/**
 * Provider component that manages context menu handlers and IPC communication
 * @param props - Component properties
 * @param props.children - Child React nodes to render within the provider
 * @returns JSX element wrapping children with context menu functionality
 */
export function ContextMenuProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const handlersRef = useRef<Map<string, ContextMenuHandler>>(new Map());

  useEffect(() => {
    const handleContextMenuCommand = (command: unknown, params: unknown) => {
      const { type, id } = params as { type: string; id: string };
      const key = `${type}:${id}`;
      const handler = handlersRef.current.get(key);

      if (handler) {
        handler(command as string, params);
      } else {
        console.warn(`No handler found for key: ${key}`);
      }
    };

    // 使用 on 方法返回的 unsubscribe 函数
    const unsubscribeContextMenu = window.electron.ipcRenderer.on(
      'context-menu-command',
      handleContextMenuCommand,
    );

    console.log('ContextMenuProvider: Listeners registered');

    return () => {
      console.log('ContextMenuProvider: Cleaning up listeners');
      unsubscribeContextMenu();
    };
  }, []);

  /**
   * Registers a context menu handler with a specific type and id
   * @param type - The type identifier for the handler
   * @param id - The unique identifier for the handler
   * @param handler - The function to handle context menu commands
   */
  const registerHandler = (
    type: string,
    id: string,
    handler: ContextMenuHandler,
  ) => {
    const key = `${type}:${id}`;
    handlersRef.current.set(key, handler);
  };

  /**
   * Removes a registered context menu handler
   * @param type - The type identifier for the handler
   * @param id - The unique identifier for the handler
   */
  const unregisterHandler = (type: string, id: string) => {
    const key = `${type}:${id}`;
    handlersRef.current.delete(key);
  };

  return (
    <ContextMenuContext.Provider value={{ registerHandler, unregisterHandler }}>
      {children}
    </ContextMenuContext.Provider>
  );
}

/**
 * Custom hook to access the context menu manager
 * @returns The context menu manager with register and unregister functions
 */
export const useContextMenu = () => useContext(ContextMenuContext);
