import type { StaffdeskApi } from '@shared/api';

declare global {
  interface Window {
    staffdesk: StaffdeskApi;
  }
}

export {};
