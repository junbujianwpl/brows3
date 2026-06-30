import { useState, useEffect, useCallback, useRef } from 'react';
import { ListObjectsResult, objectApi, subscribeCacheInvalidation } from '@/lib/tauri';
import { useProfileStore } from '@/store/profileStore';
import { useAppStore } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';

function mergeListResults(prev: ListObjectsResult, next: ListObjectsResult): ListObjectsResult {
  // Dedupe prefixes: only add truly new ones (avoids Set allocation for large arrays)
  let mergedPrefixes: string[];
  if (next.common_prefixes.length === 0) {
    mergedPrefixes = prev.common_prefixes;
  } else if (prev.common_prefixes.length === 0) {
    mergedPrefixes = next.common_prefixes;
  } else {
    const seen = new Set(prev.common_prefixes);
    const added = next.common_prefixes.filter(p => !seen.has(p));
    mergedPrefixes = added.length > 0 ? prev.common_prefixes.concat(added) : prev.common_prefixes;
  }

  return {
    ...next,
    objects: prev.objects.concat(next.objects),
    common_prefixes: mergedPrefixes,
    prefix: prev.prefix,
  };
}

const LARGE_DIR_THRESHOLD = 2000;

interface LargeDirCacheEntry {
  data: ListObjectsResult;
  timestamp: number;
}

const largeDirCache = new Map<string, LargeDirCacheEntry>();

function getCacheTtlMs(): number {
  return useSettingsStore.getState().largeDirCacheTtlMinutes * 60 * 1000;
}

function isEntryExpired(entry: LargeDirCacheEntry): boolean {
  return Date.now() - entry.timestamp > getCacheTtlMs();
}

export function clearLargeDirCache() {
  largeDirCache.clear();
}

export function removeLargeDirCacheEntry(viewKey: string) {
  largeDirCache.delete(viewKey);
}

export function getLargeDirCacheStats(): { entryCount: number; totalItems: number; oldestAge: number | null; ttlMinutes: number } {
  let totalItems = 0;
  let oldestTimestamp: number | null = null;
  for (const entry of largeDirCache.values()) {
    totalItems += getTotalItemCount(entry.data);
    if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
      oldestTimestamp = entry.timestamp;
    }
  }
  return {
    entryCount: largeDirCache.size,
    totalItems,
    oldestAge: oldestTimestamp !== null ? Date.now() - oldestTimestamp : null,
    ttlMinutes: useSettingsStore.getState().largeDirCacheTtlMinutes,
  };
}

function getTotalItemCount(data: ListObjectsResult): number {
  return data.common_prefixes.length + data.objects.length;
}

interface BucketStats {
  isCached: boolean;
  isLargeDirCached: boolean;
}

interface UseObjectsResult {
  data: ListObjectsResult | null;
  isLoading: boolean;
  error: string | null;
  stats: BucketStats;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  isLoadingMore: boolean;
  hasMore: boolean;
  isPrefetching: boolean;
  /** True when stale cached data is displayed while fresh data is being fetched in the background. */
  isRevalidating: boolean;
}

export function useObjects(bucketName: string, bucketRegion?: string, prefix = ''): UseObjectsResult {
  const [data, setData] = useState<ListObjectsResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<BucketStats>({ 
    isCached: false, 
    isLargeDirCached: false,
  });
  
  const { activeProfileId } = useProfileStore();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [continuationToken, setContinuationToken] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  
  const fetchIdRef = useRef(0);
  const lastDataKeyRef = useRef<string>('');
  const viewKeyRef = useRef<string>('');
  const loadedViewKeyRef = useRef<string>('');
  const fetchInProgress = useRef(false);
  const continuationTokenRef = useRef<string | null>(null);
  const pageInFlightRef = useRef(false);
  /** Non-zero while an automatic prefetch chain for the matching id may still be running. */
  const prefetchOwnerIdRef = useRef(0);
  const prefetchSerialRef = useRef(0);

  useEffect(() => {
    continuationTokenRef.current = continuationToken;
  }, [continuationToken]);

  // Core fetch function. When `silent` is true, stale data stays visible (no loading spinner, no data clear).
  const fetchItems = useCallback(async (bypassCache = false, silent = false) => {
    if (!bucketName || !activeProfileId) return null;
    
    const currentFetchId = ++fetchIdRef.current;
    const currentViewKey = `${activeProfileId}:${bucketName}:${prefix}`;
    const activeRegion = useAppStore.getState().discoveredRegions[bucketName] || bucketRegion;
    fetchInProgress.current = true;
    if (!silent) {
      setIsLoading(true);
      setError(null);

      const key = `${bucketName}/${prefix}`;
      if (key !== lastDataKeyRef.current) {
          setData(null);
          lastDataKeyRef.current = key;
      }
    }

    if (bypassCache) {
      setContinuationToken(null);
      continuationTokenRef.current = null;
      setHasMore(false);
    }

    let prefetchToken: string | null = null;
    let listResult: ListObjectsResult | null = null;

    try {
      const result = await objectApi.listObjects(bucketName, activeRegion, prefix, '/', undefined, bypassCache);
      
      // RACING CONDITION FIX:
      // If a new fetch started while we were awaiting, ignore this result.
      if (currentFetchId !== fetchIdRef.current || currentViewKey !== viewKeyRef.current) {
        listResult = null;
      } else {
        setData(result);
        prefetchToken = result.next_continuation_token || null;
        setContinuationToken(prefetchToken);
        setHasMore(!!prefetchToken);
        loadedViewKeyRef.current = currentViewKey;

        if (result.bucket_region) {
          useAppStore.getState().setDiscoveredRegion(bucketName, result.bucket_region);
        }

        listResult = result;
      }
    } catch (err: any) {
      if (currentFetchId !== fetchIdRef.current || currentViewKey !== viewKeyRef.current) {
        listResult = null;
      } else {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`Failed to load bucket "${bucketName}" with prefix "${prefix}":`, err);
        }
        setError(err.message || String(err));
        listResult = null;
      }
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setIsLoading(false);
        fetchInProgress.current = false;
      }
    }

    if (
      prefetchToken &&
      currentFetchId === fetchIdRef.current &&
      currentViewKey === viewKeyRef.current
    ) {
      const ownerId = ++prefetchSerialRef.current;
      prefetchOwnerIdRef.current = ownerId;
      setIsPrefetching(true);
      void (async () => {
        let token: string | null = prefetchToken;
        let accumulated: ListObjectsResult | null = listResult;
        let pagesSinceFlush = 0;
        const FLUSH_INTERVAL = 5;
        try {
          while (token) {
            if (fetchIdRef.current !== currentFetchId || viewKeyRef.current !== currentViewKey) {
              break;
            }
            pageInFlightRef.current = true;
            try {
              const region = useAppStore.getState().discoveredRegions[bucketName] || bucketRegion;
              const page = await objectApi.listObjects(bucketName, region, prefix, '/', token, false);
              if (fetchIdRef.current !== currentFetchId || viewKeyRef.current !== currentViewKey) {
                break;
              }
              accumulated = accumulated ? mergeListResults(accumulated, page) : page;
              token = page.next_continuation_token || null;
              pagesSinceFlush++;

              // Batch UI updates: flush every N pages or on last page
              if (!token || pagesSinceFlush >= FLUSH_INTERVAL) {
                setData(accumulated);
                setContinuationToken(token);
                setHasMore(!!token);
                pagesSinceFlush = 0;
              }
            } catch (e) {
              if (process.env.NODE_ENV === 'development') {
                console.warn('Prefetch page error:', e);
              }
              break;
            } finally {
              pageInFlightRef.current = false;
            }
          }
        } finally {
          if (prefetchOwnerIdRef.current === ownerId) {
            prefetchOwnerIdRef.current = 0;
            setIsPrefetching(false);
          }
          // Cache large directories after all pages loaded
          if (
            accumulated &&
            !token &&
            currentFetchId === fetchIdRef.current &&
            getTotalItemCount(accumulated) >= LARGE_DIR_THRESHOLD
          ) {
            largeDirCache.set(currentViewKey, { data: accumulated, timestamp: Date.now() });
          }
        }
      })();
    } else if (
      listResult &&
      !prefetchToken &&
      currentFetchId === fetchIdRef.current &&
      getTotalItemCount(listResult) >= LARGE_DIR_THRESHOLD
    ) {
      // Single-page result exceeds threshold — cache immediately
      largeDirCache.set(currentViewKey, { data: listResult, timestamp: Date.now() });
    }

    return listResult;
  }, [bucketName, bucketRegion, prefix, activeProfileId]);

  useEffect(() => {
    let cancelled = false;
    const currentKey = `${activeProfileId}:${bucketName}:${prefix}`;
    
    if (loadedViewKeyRef.current === currentKey) {
      return;
    }

    viewKeyRef.current = currentKey;

    // Check large directory cache before fetching from S3
    const cached = largeDirCache.get(currentKey);
    if (cached) {
      if (isEntryExpired(cached)) {
        // SWR: serve stale data immediately, revalidate fully in background
        setData(cached.data);
        setIsLoading(false);
        setContinuationToken(null);
        setHasMore(false);
        loadedViewKeyRef.current = currentKey;
        setStats({ isCached: true, isLargeDirCached: true });
        setIsRevalidating(true);

        const revalidate = async () => {
          const currentFetchId = ++fetchIdRef.current;
          const activeRegion = useAppStore.getState().discoveredRegions[bucketName] || bucketRegion;
          let accumulated: ListObjectsResult | null = null;
          let token: string | undefined;

          try {
            do {
              if (fetchIdRef.current !== currentFetchId || viewKeyRef.current !== currentKey) return;
              const page = await objectApi.listObjects(bucketName, activeRegion, prefix, '/', token, true);
              if (fetchIdRef.current !== currentFetchId || viewKeyRef.current !== currentKey) return;
              accumulated = accumulated ? mergeListResults(accumulated, page) : page;
              token = page.next_continuation_token || undefined;
            } while (token);
          } catch {
            // Revalidation failed silently — stale data remains visible
            if (!cancelled) setIsRevalidating(false);
            return;
          }

          if (cancelled || fetchIdRef.current !== currentFetchId || viewKeyRef.current !== currentKey) return;

          // Replace data atomically with the full result
          setData(accumulated);
          setContinuationToken(null);
          setHasMore(false);
          setIsRevalidating(false);
          setStats({ isCached: true, isLargeDirCached: true });

          // Update cache with fresh data
          if (accumulated && getTotalItemCount(accumulated) >= LARGE_DIR_THRESHOLD) {
            largeDirCache.set(currentKey, { data: accumulated, timestamp: Date.now() });
          } else {
            largeDirCache.delete(currentKey);
          }
        };
        revalidate();
      } else {
        setData(cached.data);
        setIsLoading(false);
        setContinuationToken(null);
        setHasMore(false);
        loadedViewKeyRef.current = currentKey;
        setStats({ isCached: true, isLargeDirCached: true });
        return;
      }
      return;
    }

    setData(null);
    setIsLoading(true);
    setContinuationToken(null);
    setHasMore(false);

    const run = async () => {
      await fetchItems(false);
      if (!cancelled) {
        setStats({ isCached: true, isLargeDirCached: false });
      }
    };

    run();
    return () => {
      cancelled = true;
      if (viewKeyRef.current === currentKey) {
        viewKeyRef.current = '';
      }
    };
  }, [bucketName, prefix, activeProfileId, fetchItems]);

  useEffect(() => {
    return subscribeCacheInvalidation(() => {
      fetchIdRef.current += 1;
      prefetchSerialRef.current += 1;
      prefetchOwnerIdRef.current = 0;
      loadedViewKeyRef.current = '';
      lastDataKeyRef.current = '';
      largeDirCache.clear();
      setData(null);
      setContinuationToken(null);
      continuationTokenRef.current = null;
      setHasMore(false);
      setIsPrefetching(false);
      setIsRevalidating(false);
      setStats({ isCached: false, isLargeDirCached: false });
    });
  }, []);

  // Track last fetch time
  const lastFetchTime = useRef<number>(0);

  // Refresh when tab regains visibility (user returns to app)
  const autoRefreshOnFocus = useSettingsStore(state => state.autoRefreshOnFocus);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && bucketName && activeProfileId && autoRefreshOnFocus) {
        // Skip auto-refresh for large cached directories (unless expired)
        const viewKey = `${activeProfileId}:${bucketName}:${prefix}`;
        const cachedEntry = largeDirCache.get(viewKey);
        if (cachedEntry && !isEntryExpired(cachedEntry)) return;

        const now = Date.now();
        if (now - lastFetchTime.current > 30000) {
          lastFetchTime.current = now;
          fetchItems(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [bucketName, activeProfileId, prefix, fetchItems, autoRefreshOnFocus]);

  const loadMore = useCallback(async () => {
    if (!bucketName || !activeProfileId || fetchInProgress.current) return;
    if (prefetchOwnerIdRef.current !== 0) return;
    const requestToken = continuationTokenRef.current;
    if (!requestToken || pageInFlightRef.current) return;

    const currentViewKey = `${activeProfileId}:${bucketName}:${prefix}`;
    const activeRegion = useAppStore.getState().discoveredRegions[bucketName] || bucketRegion;
    const currentFetchId = fetchIdRef.current;

    pageInFlightRef.current = true;
    setIsLoadingMore(true);
    try {
      const result = await objectApi.listObjects(bucketName, activeRegion, prefix, '/', requestToken);
      if (currentViewKey !== viewKeyRef.current || currentFetchId !== fetchIdRef.current) {
        return;
      }
      setData((prev) => (prev ? mergeListResults(prev, result) : result));
      const nextTok = result.next_continuation_token || null;
      setContinuationToken(nextTok);
      setHasMore(!!nextTok);
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      pageInFlightRef.current = false;
      setIsLoadingMore(false);
    }
  }, [bucketName, bucketRegion, prefix, activeProfileId]);

  const refresh = useCallback(async () => {
    if (!bucketName || !activeProfileId) return;
    const viewKey = `${activeProfileId}:${bucketName}:${prefix}`;
    largeDirCache.delete(viewKey);
    setStats(prev => ({ ...prev, isLargeDirCached: false }));
    setIsRevalidating(false);
    setData(null);
    await fetchItems(true);
  }, [bucketName, activeProfileId, prefix, fetchItems]);

  return { data, isLoading, error, stats, refresh, loadMore, hasMore, isLoadingMore, isPrefetching, isRevalidating };
}
