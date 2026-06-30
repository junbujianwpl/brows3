'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Button,
} from '@mui/material';
import {
  History as HistoryIcon,
  Folder as FolderIcon,
  InsertDriveFile as FileIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { useHistoryStore, RecentItem } from '@/store/historyStore';
import { useAppStore } from '@/store/appStore';
import { useProfileStore } from '@/store/profileStore';
import { formatDate } from '@/lib/utils';

export default function RecentPage() {
  const router = useRouter();
  const { recentItems, clearRecent } = useHistoryStore();
  const { addTab, discoveredRegions } = useAppStore();
  const { activeProfileId, profiles } = useProfileStore();
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const [now] = useState(() => Date.now());

  const visibleRecentItems = recentItems.filter((item) => item.profileId === activeProfileId);

  const buildBucketPath = (item: RecentItem, prefix?: string) => {
    const params = new URLSearchParams();
    params.set('name', item.bucket);
    const region = item.region || discoveredRegions[item.bucket] || activeProfile?.region;
    if (region) params.set('region', region);
    if (prefix) params.set('prefix', prefix);
    return `/bucket?${params.toString()}`;
  };

  const handleItemClick = (item: RecentItem) => {
    if (item.isFolder) {
      const path = buildBucketPath(item, item.key);
      addTab({ title: item.name, path, icon: 'folder' });
      router.push(path);
    } else {
      // Navigate to parent folder with the file selected
      const parentPrefix = item.key.split('/').slice(0, -1).join('/');
      const path = buildBucketPath(item, parentPrefix ? `${parentPrefix}/` : undefined);
      addTab({ title: item.bucket, path, icon: 'bucket' });
      router.push(path);
    }
  };

  const formatTime = (timestamp: number) => {
    const diff = now - timestamp;
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
    return formatDate(timestamp);
  };

  return (
    <Box sx={{ p: 1, mt: 1, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <HistoryIcon color="primary" sx={{ fontSize: 40 }} />
          <Box>
            <Typography variant="h4" fontWeight={700}>
              Recent
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Recently accessed files and folders
            </Typography>
          </Box>
        </Box>
        {visibleRecentItems.length > 0 && (
          <Button 
            variant="outlined" 
            color="error" 
            size="small"
            startIcon={<DeleteIcon />}
            onClick={() => clearRecent(activeProfileId || undefined)}
          >
            Clear All
          </Button>
        )}
      </Box>

      {visibleRecentItems.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <HistoryIcon sx={{ fontSize: 60, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No recent items
          </Typography>
          <Typography variant="body2" color="text.disabled">
            Files and folders you access will appear here
          </Typography>
        </Paper>
      ) : (
        <Paper variant="outlined" sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <List dense sx={{ flex: 1, overflow: 'auto' }}>
            {visibleRecentItems.map((item, index) => (
              <ListItem
                key={`${item.bucket}-${item.key}-${index}`}
                disablePadding
                secondaryAction={
                  <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                    {formatTime(item.timestamp || 0)}
                  </Typography>
                }
              >
                <ListItemButton onClick={() => handleItemClick(item)}>
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    {item.isFolder ? (
                      <FolderIcon sx={{ color: '#FFB74D' }} />
                    ) : (
                      <FileIcon color="action" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={item.name}
                    secondary={`${item.bucket} / ${item.key}`}
                    primaryTypographyProps={{ fontWeight: 500 }}
                    secondaryTypographyProps={{ 
                      noWrap: true, 
                      sx: { maxWidth: 400 },
                      title: `${item.bucket}/${item.key}`,
                    }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  );
}
