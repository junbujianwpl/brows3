// Utility functions shared across the application

/**
 * Format bytes into human-readable size string
 * @param bytes - Number of bytes
 * @returns Formatted string like "1.5 MB"
 */
export const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

/**
 * Get file extension from filename
 * @param name - Filename or path
 * @returns Lowercase extension without dot, or empty string
 */
export const getFileExtension = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Date without zero-padding: yy/M/d
 */
export const formatDate = (input: string | number | null): string => {
  if (input == null) return '—';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '—';
  return `${d.getFullYear() % 100}/${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * Time with zero-padding: HH:mm
 */
export const formatTime = (input: string | number | null): string => {
  if (input == null) return '—';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * Date (no pad) + Time (padded): yy/M/d HH:mm
 */
export const formatDateTime = (input: string | number | null): string => {
  if (input == null) return '—';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '—';
  const y = d.getFullYear() % 100;
  return `${y}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
