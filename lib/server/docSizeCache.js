import LRU from 'lru-cache';
import jsonStringify from 'json-stringify-safe';

export class DocSzCacheItem {
  constructor(maxValues) {
    this.maxValues = maxValues;
    this.updated = 0;
    this.values = [];
  }

  addData(value) {
    this.values.push(value);
    this.updated = Date.now();

    if (this.values.length > this.maxValues) {
      this.values.shift();
    }
  }

  getValue() {
    const sorted = this.values.sort((a, b) => a - b);
    let median = 0;

    if (sorted.length % 2 === 0) {
      const idx = sorted.length / 2;
      median = (sorted[idx] + sorted[idx - 1]) / 2;
    } else {
      const idx = Math.floor(sorted.length / 2);
      median = sorted[idx];
    }

    return median;
  }
}

export class DocSzCache {
  constructor(maxItems, maxValues) {
    this.items = new LRU({ max: maxItems });
    this.maxValues = maxValues;
    this.cpuUsage = 0;
  }

  // This is called from SystemModel.prototype.getUsage and saves cpu usage.
  setPcpu(pcpu) {
    this.cpuUsage = pcpu;
  }

  getSize(coll, query, opts, data) {
    // If the dataset is null or empty we can't calculate the size
    // Do not process this data and return 0 as the document size.
    if (!(data && (data.length || data.size))) {
      return 0;
    }

    const key = this.getKey(coll, query, opts);
    let item = this.items.get(key);

    if (!item) {
      item = new DocSzCacheItem(this.maxValues);
      this.items.set(key, item);
    }

    if (this.needsUpdate(item)) {
      let doc = {};

      if (typeof data.get === 'function') {
        // This is an IdMap
        data.forEach((element) => {
          doc = element;
          return false; // return false to stop loop. We only need one doc.
        });
      } else {
        doc = data[0];
      }

      const size = Buffer.byteLength(jsonStringify(doc), 'utf8');
      item.addData(size);
    }

    return item.getValue();
  }

  getKey(coll, query, opts) {
    return jsonStringify([coll, query, opts]);
  }

  // returns a score between 0 and 1 for a cache item
  // this score is determined by:
  //  * availalbe cache item slots
  //  * time since last updated
  //  * cpu usage of the application
  getItemScore(item) {
    return [
      (item.maxValues - item.values.length) / item.maxValues,
      (Date.now() - item.updated) / 60000,
      (100 - this.cpuUsage) / 100,
    ].map((score) => {
      return score > 1 ? 1 : score;
    }).reduce((total, score) => {
      return (total || 0) + score;
    }) / 3;
  }

  needsUpdate(item) {
    // handle newly made items
    if (!item.values.length) {
      return true;
    }

    const currentTime = Date.now();
    const timeSinceUpdate = currentTime - item.updated;
    if (timeSinceUpdate > 1000 * 60) {
      return true;
    }

    return this.getItemScore(item) > 0.5;
  }
}
