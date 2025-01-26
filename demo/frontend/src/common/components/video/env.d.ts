declare global {
  interface ImportMetaEnv {
    VITE_AZURE_STORAGE_CONNECTION_STRING: string;
    VITE_AZURE_STORAGE_CONTAINER_NAME: string;
  }
}

export {};
