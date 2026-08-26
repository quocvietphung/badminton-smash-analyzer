export type StudioView = "live" | "sessions" | "coach" | "settings";
export type StudioLanguage = "vi" | "en";
export type StudioTheme = "dark" | "light";

export type CoachPromptRequest = {
  id: number;
  text: string;
};
