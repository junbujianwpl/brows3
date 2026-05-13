import { useState, useEffect, useCallback, useRef } from 'react';
import { ListObjectsResult, objectApi, subscribeCacheInvalidation } from '@/lib/tauri';
import { useProfileStore } from '@/store/profileStore';
import { useAppStore } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';

function mergeListResults(prev: ListObjectsResult, next: ListObjectsResult): ListObjectsResult {
  const uniquePrefixes = Array.from(new Set([...prev.common_prefixes, ...next.common_prefixes]));
  return {
    ...next,
    objects: [...prev.objects, ...next.objects],
    common_prefixes: uniquePrefixes,
    prefix: prev.prefix,
  };
}

interface BucketStats {
  isCached: boolean;
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
}

export function useObjects(bucketName: string, bucketRegion?: string, prefix = ''): UseObjectsResult {
  const [data, setData] = useState<ListObjectsResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<BucketStats>({ 
    isCached: false, 
  });
  
  const { activeProfileId } = useProfileStore();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isPrefetching, setIsPrefetching] = useState(false);
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

  // Core fetch function
  const fetchItems = useCallback(async (bypassCache = false) => {
    if (!bucketName || !activeProfileId) return null;
    
    const currentFetchId = ++fetchIdRef.current;
    const currentViewKey = `${activeProfileId}:${bucketName}:${prefix}`;
    const activeRegion = useAppStore.getState().discoveredRegions[bucketName] || bucketRegion;
    fetchInProgress.current = true;
    setIsLoading(true);
    setError(null);

    const key = `${bucketName}/${prefix}`;
    if (key !== lastDataKeyRef.current) {
        setData(null);
        lastDataKeyRef.current = key;
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
              setData((prev) => (prev ? mergeListResults(prev, page) : page));
              token = page.next_continuation_token || null;
              setContinuationToken(token);
              setHasMore(!!token);
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
        }
      })();
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

    setData(null);
    setIsLoading(true);
    setContinuationToken(null);
    setHasMore(false);

    const run = async () => {
      await fetchItems(false);
      if (!cancelled) {
        setStats({ isCached: true });
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
      setData(null);
      setContinuationToken(null);
      continuationTokenRef.current = null;
      setHasMore(false);
      setIsPrefetching(false);
    });
  }, []);

  // Track last fetch time
  const lastFetchTime = useRef<number>(0);

  // Refresh when tab regains visibility (user returns to app)
  const autoRefreshOnFocus = useSettingsStore(state => state.autoRefreshOnFocus);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && bucketName && activeProfileId && autoRefreshOnFocus) {
        // Only refresh if last fetch was > 30 seconds ago
        const now = Date.now();
        if (now - lastFetchTime.current > 30000) {
          lastFetchTime.current = now;
          fetchItems(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [bucketName, activeProfileId, fetchItems, autoRefreshOnFocus]);

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
    setData(null);
    await fetchItems(true);
  }, [bucketName, activeProfileId, fetchItems]);

  return { data, isLoading, error, stats, refresh, loadMore, hasMore, isLoadingMore, isPrefetching };
}
