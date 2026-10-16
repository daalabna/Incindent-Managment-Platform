import { create } from "zustand";
export type Page =
  | "Overview"
  | "Incidents"
  | "Services"
  | "Alert rules"
  | "Activity log"
  | "Operations";
export const useUI = create<{
  page: Page;
  selectPage: (page: Page) => void;
  selected: string | null;
  selectIncident: (id: string | null) => void;
}>((set) => ({
  page: "Overview",
  selectPage: (page) => set({ page }),
  selected: null,
  selectIncident: (selected) => set({ selected }),
}));
