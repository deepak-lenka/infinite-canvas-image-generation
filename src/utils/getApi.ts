// expert level environment variables
export const getApi = () => {
  if (import.meta.env.DEV) {
    return "http://localhost:3000";
  }
  const apiUrl = String(import.meta.env.VITE_API_URL ?? "").trim();
  if (apiUrl.length > 0) {
    return apiUrl.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
};
