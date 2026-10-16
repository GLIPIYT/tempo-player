use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

use super::models::{RepeatMode, TrackPayload, MAX_QUEUE_ITEMS};

static ENTRY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: String,
    pub track: Value,
}

impl QueueEntry {
    fn new(track: Value) -> Self {
        let sequence = ENTRY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        Self {
            id: format!("{nanos:x}-{sequence:x}"),
            track,
        }
    }

    pub fn identity_key(&self) -> String {
        TrackPayload(self.track.clone()).identity_key()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeQueue {
    base: Vec<QueueEntry>,
    items: Vec<QueueEntry>,
    index: Option<usize>,
    shuffled: bool,
}

impl NativeQueue {
    pub fn sanitize(&mut self) {
        if self.base.len() > MAX_QUEUE_ITEMS {
            self.base.truncate(MAX_QUEUE_ITEMS);
        }
        if self.items.len() > MAX_QUEUE_ITEMS {
            self.items.truncate(MAX_QUEUE_ITEMS);
        }
        let mut base_ids = std::collections::HashSet::new();
        self.base.retain(|entry| {
            !entry.id.is_empty()
                && base_ids.insert(entry.id.clone())
                && TrackPayload::parse(entry.track.clone()).is_ok()
        });
        let mut item_ids = std::collections::HashSet::new();
        let valid_items = self.items.len() == self.base.len()
            && self.items.iter().all(|entry| {
                base_ids.contains(&entry.id)
                    && item_ids.insert(entry.id.clone())
                    && TrackPayload::parse(entry.track.clone()).is_ok()
            });
        if !valid_items {
            self.items = self.base.clone();
            self.shuffled = false;
        }
        self.index = self.index.filter(|index| *index < self.items.len());
        if self.items.is_empty() {
            self.index = None;
        }
        if !self.items.is_empty() && self.index.is_none() {
            self.index = Some(0);
        }
    }

    pub fn items(&self) -> &[QueueEntry] {
        &self.items
    }
    pub fn tracks(&self) -> Vec<Value> {
        self.items.iter().map(|entry| entry.track.clone()).collect()
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn index(&self) -> i64 {
        self.index.map(|value| value as i64).unwrap_or(-1)
    }
    pub fn current(&self) -> Option<&QueueEntry> {
        self.index.and_then(|index| self.items.get(index))
    }
    pub fn replace(&mut self, tracks: Vec<Value>, start_index: usize) -> Result<(), String> {
        if tracks.len() > MAX_QUEUE_ITEMS {
            return Err(format!("queue exceeds {MAX_QUEUE_ITEMS} tracks"));
        }
        let entries: Vec<_> = tracks.into_iter().map(QueueEntry::new).collect();
        if entries.is_empty() {
            self.base.clear();
            self.items.clear();
            self.index = None;
            return Ok(());
        }
        let start = start_index.min(entries.len() - 1);
        self.base = entries;
        if self.shuffled {
            let head_id = self.base[start].id.clone();
            let mut rest: Vec<_> = self
                .base
                .iter()
                .filter(|entry| entry.id != head_id)
                .cloned()
                .collect();
            shuffle(&mut rest);
            self.items = vec![self.base[start].clone()];
            self.items.extend(rest);
            self.index = Some(0);
        } else {
            self.items = self.base.clone();
            self.index = Some(start);
        }
        Ok(())
    }

    pub fn next(&mut self, repeat: RepeatMode) -> Option<QueueEntry> {
        let index = self.index?;
        if index + 1 < self.items.len() {
            self.index = Some(index + 1);
            return self.current().cloned();
        }
        if repeat == RepeatMode::All && !self.items.is_empty() {
            self.index = Some(0);
            return self.current().cloned();
        }
        None
    }

    pub fn previous(&mut self, repeat: RepeatMode) -> Option<QueueEntry> {
        let index = self.index?;
        if index > 0 {
            self.index = Some(index - 1);
            return self.current().cloned();
        }
        if repeat == RepeatMode::All && !self.items.is_empty() {
            self.index = Some(self.items.len() - 1);
            return self.current().cloned();
        }
        None
    }

    pub fn peek_next(&self, repeat: RepeatMode) -> Option<QueueEntry> {
        let index = self.index?;
        if index + 1 < self.items.len() {
            return self.items.get(index + 1).cloned();
        }
        if repeat == RepeatMode::All {
            return self.items.first().cloned();
        }
        None
    }

    pub fn append(&mut self, track: Value, next: bool) -> Result<QueueEntry, String> {
        if self.items.len() >= MAX_QUEUE_ITEMS {
            return Err(format!("queue exceeds {MAX_QUEUE_ITEMS} tracks"));
        }
        let entry = QueueEntry::new(track);
        if self.items.is_empty() {
            self.base.push(entry.clone());
            self.items.push(entry.clone());
            self.index = Some(0);
            return Ok(entry);
        }
        if next {
            let insert_at = self
                .index
                .map(|index| index + 1)
                .unwrap_or(self.items.len());
            self.items.insert(insert_at, entry.clone());
            let current_id = insert_at
                .checked_sub(1)
                .and_then(|index| self.items.get(index))
                .map(|item| item.id.as_str());
            if let Some(base_at) =
                current_id.and_then(|id| self.base.iter().position(|item| item.id == id))
            {
                self.base.insert(base_at + 1, entry.clone());
            } else {
                self.base.push(entry.clone());
            }
        } else {
            self.base.push(entry.clone());
            self.items.push(entry.clone());
        }
        Ok(entry)
    }

    pub fn move_item(&mut self, from: usize, to: usize) {
        let len = self.items.len();
        if from >= len || to >= len || from == to {
            return;
        }
        let moved = self.items.remove(from);
        self.items.insert(to, moved.clone());
        if let Some(base_at) = self.base.iter().position(|entry| entry.id == moved.id) {
            self.base.remove(base_at);
            if to > 0 {
                let predecessor = self.items.get(to - 1).map(|entry| entry.id.as_str());
                if let Some(predecessor_at) =
                    predecessor.and_then(|id| self.base.iter().position(|entry| entry.id == id))
                {
                    self.base.insert(predecessor_at + 1, moved);
                } else {
                    self.base.push(moved);
                }
            } else {
                let successor = self.items.get(to + 1).map(|entry| entry.id.as_str());
                if let Some(successor_at) =
                    successor.and_then(|id| self.base.iter().position(|entry| entry.id == id))
                {
                    self.base.insert(successor_at, moved);
                } else {
                    self.base.push(moved);
                }
            }
        }
        if let Some(index) = self.index.as_mut() {
            if from == *index {
                *index = to;
            } else if from < *index && to >= *index {
                *index -= 1;
            } else if from > *index && to <= *index {
                *index += 1;
            }
        }
    }

    pub fn remove(&mut self, index: usize) -> Option<bool> {
        if index >= self.items.len() {
            return None;
        }
        let was_current = self.index == Some(index);
        let removed = self.items.remove(index);
        if let Some(base_at) = self.base.iter().position(|entry| entry.id == removed.id) {
            self.base.remove(base_at);
        }
        if let Some(current) = self.index.as_mut() {
            if index < *current {
                *current -= 1;
            } else if index == *current && *current >= self.items.len() {
                *current = self.items.len().checked_sub(1).unwrap_or(0);
            }
        }
        if self.items.is_empty() {
            self.index = None;
        }
        Some(was_current)
    }

    pub fn clear(&mut self) {
        self.base.clear();
        self.items.clear();
        self.index = None;
    }

    pub fn set_shuffled(&mut self, on: bool) {
        if on == self.shuffled {
            return;
        }
        self.shuffled = on;
        if self.items.len() <= 1 {
            return;
        }
        if on {
            let current = self.current().cloned();
            let current_id = current.as_ref().map(|entry| entry.id.clone());
            let mut rest: Vec<_> = self
                .items
                .iter()
                .filter(|entry| Some(&entry.id) != current_id.as_ref())
                .cloned()
                .collect();
            shuffle(&mut rest);
            self.items = current.into_iter().collect();
            self.items.extend(rest);
            self.index = Some(0);
        } else {
            let current_id = self.current().map(|entry| entry.id.clone());
            self.items = self.base.clone();
            self.index = current_id
                .as_ref()
                .and_then(|id| self.items.iter().position(|entry| &entry.id == id))
                .or_else(|| (!self.items.is_empty()).then_some(0));
        }
    }

    pub fn update_track(&mut self, payload: Value) -> Result<bool, String> {
        let incoming = TrackPayload::parse(payload)?;
        let key = incoming.identity_key();
        let mut changed = false;
        let merge = |old: &Value| {
            let mut object = old.as_object().cloned().unwrap_or_default();
            if let Some(update) = incoming.0.as_object() {
                for (key, value) in update {
                    object.insert(key.clone(), value.clone());
                }
            }
            Value::Object(object)
        };
        for entry in &mut self.base {
            if entry.identity_key() == key {
                entry.track = merge(&entry.track);
                changed = true;
            }
        }
        for entry in &mut self.items {
            if entry.identity_key() == key {
                entry.track = merge(&entry.track);
                changed = true;
            }
        }
        Ok(changed)
    }

    pub fn update_entry(&mut self, id: &str, track: Value) {
        for entry in self.base.iter_mut().chain(self.items.iter_mut()) {
            if entry.id == id {
                entry.track = track.clone();
            }
        }
    }
}

fn shuffle<T>(items: &mut [T]) {
    if items.len() < 2 {
        return;
    }
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
        ^ ENTRY_SEQUENCE
            .fetch_add(1, Ordering::Relaxed)
            .rotate_left(23);
    for index in (1..items.len()).rev() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let other = (state as usize) % (index + 1);
        items.swap(index, other);
    }
}
