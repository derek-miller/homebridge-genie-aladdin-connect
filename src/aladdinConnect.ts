import { Logger } from 'homebridge';
import cacheManager, { Cache } from 'cache-manager';

import * as https from 'https';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';
import PubSub from 'pubsub-js';
import Token = PubSubJS.Token;
import AsyncLock from 'async-lock';

interface AladdinUserInfo {
  email: string;
  fullName: string;
  id: string;
  rid: string;
  meta: AladdinUserInfoMeta | null;
  phoneNumber: string;
  userName: string;
  activated: boolean;
  // groups: AladdinGroup[]; // TODO
  permissions: AladdinUserPermission[];
}

interface AladdinUserInfoMeta {
  acceptTerms: boolean;
  securityQuestion: number;
  securityAnswer: string;
}

interface AladdinUserPermission {
  access: string;
  oid: AladdinUserPermissionOid;
}

interface AladdinUserPermissionOid {
  type: AladdinUserPermissionType;
  id: string;
}

type AladdinUserPermissionType = 'Portal' | 'Domain' | 'Device';

interface AladdinPortal {
  PortalName: string;
  PortalID: string;
  PortalRID: string;
  UserEmail: string;
  Description: string;
  Permissions: AladdinPortalPermission[];
}

interface AladdinPortalPermission {
  access: string;
}

interface AladdinPortalDetails {
  devices: string[];
  id: string;
  info: AladdinPortalDetailsInfo;
}

interface AladdinPortalDetailsInfo {
  key: string;
  // TODO incomplete
}

export interface AladdinDoor {
  portal: string;
  device: string;
  id: number;
  name: string;
}

export interface AladdinDoorStatusInfo {
  door: AladdinDoor;
  status: AladdinDoorStatus;
  desiredStatus: AladdinDesiredDoorStatus;
  batteryPercent: number | null;
  fault: boolean;
}

export enum AladdinDoorStatus {
  UNKNOWN = 0,
  OPEN = 1,
  OPENING = 2,
  TIMEOUT_OPENING = 3,
  CLOSED = 4,
  CLOSING = 5,
  TIMEOUT_CLOSING = 6,
  NOT_CONFIGURED = 7,
}

export enum AladdinDesiredDoorStatus {
  CLOSED = 0,
  OPEN = 1,
  NONE = 99, // Once the garage is in the desired state Genie reports this.
}

enum AladdinLink {
  UNKNOWN = 0,
  NOT_CONFIGURED = 1,
  PAIRED = 2,
  CONNECTED = 3,
}

export interface AladdinConnectConfig {
  username: string;
  password: string;
  userInfoCacheTtl?: number;
  doorStatusPollInterval?: number;
  doorStatusStationaryCacheTtl?: number;
  doorStatusTransitioningCacheTtl?: number;
}

/**
 * https://documenter.getpostman.com/view/5856894/RzZAjHxV#cfb1b456-2c2d-42a5-9b73-6053d87a3feb
 */
export class AladdinConnect {
  private static readonly ALL_DOOR_IDS = [1, 2, 3];
  private static readonly PUB_SUB_DOOR_STATUS_TOPIC = 'door';

  private static readonly USER_DATA_CACHE_TTL_S_DEFAULT = 60 * 60;
  private static readonly USER_DATA_CACHE_TTL_S_MIN = 5 * 60;
  private static readonly USER_DATA_CACHE_TTL_S_MAX = 24 * 60 * 60;

  private static readonly DOOR_STATUS_STATIONARY_CACHE_TTL_S_DEFAULT = 15;
  private static readonly DOOR_STATUS_STATIONARY_CACHE_TTL_S_MIN = 5;
  private static readonly DOOR_STATUS_STATIONARY_CACHE_TTL_S_MAX = 60;

  private static readonly DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_DEFAULT = 5;
  private static readonly DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_MIN = 1;
  private static readonly DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_MAX = 30;

  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_DEFAULT = 15 * 1000;
  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_MIN = 5 * 1000;
  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_MAX = 60 * 1000;

  private static readonly DEFAULT_HEADERS = {
    AppVersion: '3.0.0',
    BundleName: 'com.geniecompany.AladdinConnect',
    'User-Agent': 'Aladdin Connect iOS v3.0.0',
    BuildVersion: '131',
  };

  // Events
  private static readonly POLL_DOOR_STATUS = 'POLL_DOOR_STATUS';

  private static readonly DOOR_STATUS_LOCK = 'DOOR_STATUS';

  private readonly lock = new AsyncLock();
  private readonly cache: Cache;
  private readonly session: AxiosInstance;

  constructor(public readonly log: Logger, private readonly config: AladdinConnectConfig) {
    this.cache = cacheManager.caching({
      ttl: 0, // No default ttl
      max: 0, // Infinite capacity
      store: 'memory',
    });
    this.session = axios.create({
      httpsAgent: new https.Agent({ keepAlive: true }),
      timeout: 5000,
      headers: {
        ...AladdinConnect.DEFAULT_HEADERS,
      },
    });
    axiosRetry(this.session, { retries: 3 });
  }

  subscribe(door: AladdinDoor, func: (info: AladdinDoorStatusInfo) => void): Token {
    const topic = AladdinConnect.doorStatusTopic(door);
    const token = PubSub.subscribe(topic, async (_, data) => {
      if (!data) {
        return;
      }
      func(data);
    });
    this.log.debug('[API] Status subscription added for door %s [token=%s]', door.name, token);

    // When this is the first subscription, start polling to publish updates.
    if (PubSub.countSubscriptions(topic) === 1) {
      const poll = async () => {
        // Stop polling when there are no active subscriptions.
        if (PubSub.countSubscriptions(topic) === 0) {
          this.log.debug('[API] There are no door status subscriptions; skipping poll');
          return;
        }
        // Acquire the status lock before emitting any new events.
        this.log.debug('[API] Polling status for door %s', door.name);
        try {
          PubSub.publish(AladdinConnect.doorStatusTopic(door), await this.getDoorStatus(door));
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.log.error(
              '[API] An error occurred polling for a status update; %s',
              error.message,
            );
          }
        }
        setTimeout(poll, this.pollInterval);
      };
      setTimeout(poll, 0);
    }
    return token;
  }

  unsubscribe(token: Token): void {
    PubSub.unsubscribe(token);
    this.log.debug('[API] Status subscription removed for token %s', token);
  }

  async getAllDoors(): Promise<AladdinDoor[]> {
    const doorStatuses = await this.getAllDoorStatuses();
    return doorStatuses.map(({ door }) => door);
  }

  async getAllDoorStatuses(): Promise<AladdinDoorStatusInfo[]> {
    const statusPromises: Promise<AladdinDoorStatusInfo | null>[] = [];
    for (const { id: portal, devices } of await this.getUserPortalsDetails()) {
      for (const device of devices) {
        for (const id of AladdinConnect.ALL_DOOR_IDS) {
          statusPromises.push(
            this.getDoorStatus({
              portal,
              device,
              id,
            }),
          );
        }
      }
    }
    return <AladdinDoorStatusInfo[]>(
      (await Promise.all(statusPromises)).filter((status) => status !== null)
    );
  }

  async getDoorStatus(door: Omit<AladdinDoor, 'name'>): Promise<AladdinDoorStatusInfo | null> {
    return this.lock.acquire(
      AladdinConnect.DOOR_STATUS_LOCK,
      async (): Promise<AladdinDoorStatusInfo | null> =>
        this.cache.wrap(
          AladdinConnect.doorStatusCacheKey(door),
          async (): Promise<AladdinDoorStatusInfo | null> => {
            if (!AladdinConnect.ALL_DOOR_IDS.includes(door.id)) {
              throw new Error(
                `unknown door id ${door.id}; must be one of [${AladdinConnect.ALL_DOOR_IDS.join(
                  ', ',
                )}]`,
              );
            }

            const calls: object[] = [];
            let callId = 1;
            for (const func of [
              'name',
              'door_status',
              'desired_status',
              'link_status',
              'battery_level',
              'fault',
            ]) {
              calls.push({
                id: callId++,
                procedure: 'read',
                arguments: [
                  {
                    alias: `dps${door.id}.${func}`,
                  },
                  {},
                ],
              });
            }
            const response = await this.session.request({
              method: 'post',
              url: 'https://genie.m2.exosite.com/onep:v1/rpc/process',
              headers: {
                ...AladdinConnect.DEFAULT_HEADERS,
                Authorization: `Token: ${await this.getLoginToken()}`,
              },
              data: {
                auth: {
                  cik: await this.getPortalKey(door.portal),
                  client_id: door.device,
                },
                calls,
              },
            });
            const [
              nameCallResponse,
              statusCallResponse,
              desiredStatusCallResponse,
              linkStatusCallResponse,
              batteryLevelCallResponse,
              faultCallResponse,
            ] = response.data;
            const name = AladdinConnect.getCallResult(nameCallResponse);
            const status = AladdinConnect.getCallResult(
              statusCallResponse,
              AladdinDoorStatus.UNKNOWN,
            );
            const desiredStatus = AladdinConnect.getCallResult(
              desiredStatusCallResponse,
              AladdinDesiredDoorStatus.NONE,
            );
            const linkStatus = AladdinConnect.getCallResult(
              linkStatusCallResponse,
              AladdinLink.UNKNOWN,
            );
            const batteryLevel = AladdinConnect.getCallResult(batteryLevelCallResponse, null);
            const fault = !!AladdinConnect.getCallResult(faultCallResponse, 0);
            if (!name) {
              return null;
            }
            return {
              door: {
                ...door,
                name,
              },
              status: status,
              desiredStatus,
              batteryPercent: linkStatus === AladdinLink.CONNECTED ? batteryLevel ?? null : null,
              fault,
            };
          },
          {
            ttl: (info) =>
              [AladdinDoorStatus.CLOSING, AladdinDoorStatus.OPENING].includes(
                info?.status ?? AladdinDoorStatus.UNKNOWN,
              )
                ? this.doorStatusTransitioningCacheTtl
                : this.doorStatusStationaryCacheTtl,
          },
        ),
    );
  }

  async setDoorStatus(
    door: AladdinDoor,
    desiredStatus: AladdinDesiredDoorStatus,
  ): Promise<boolean> {
    return this.lock.acquire(AladdinConnect.DOOR_STATUS_LOCK, async () => {
      const response = await this.session.post('https://genie.m2.exosite.com/onep:v1/rpc/process', {
        headers: {
          Authorization: `Token: ${await this.getLoginToken()}`,
        },
        data: {
          auth: {
            cik: await this.getPortalKey(door.portal),
            client_id: door.device,
          },
          calls: [
            {
              arguments: [
                {
                  alias: `dps${door.id}.desired_status`,
                },
                desiredStatus,
              ],
              id: 1,
              procedure: 'write',
            },
            {
              arguments: [
                {
                  alias: `dps${door.id}.desired_status_user`,
                },
                this.config.username,
              ],
              id: 2,
              procedure: 'write',
            },
          ],
        },
      });
      await this.cache.del(AladdinConnect.doorStatusCacheKey(door));
      return response.data.every(({ status }) => status === 'ok');
    });
  }

  private async getLoginToken(): Promise<string> {
    return this.cache.wrap(
      'getLoginToken',
      async () => {
        const token = <AxiosResponse<string>>await this.session.get(
          'https://genie.exosite.com/api/portals/v1/users/_this/token',
          {
            headers: {
              Authorization: `Basic ${Buffer.from(
                `${this.config.username}:${this.config.password}`,
              ).toString('base64')}`,
            },
          },
        );
        return token.data;
      },
      { ttl: this.userInfoCacheTtl },
    );
  }

  private async getUserInfo(): Promise<AladdinUserInfo> {
    return this.cache.wrap(
      'getUserInfo',
      async () => {
        const response = <AxiosResponse<AladdinUserInfo>>await this.session.get(
          'https://genie.exosite.com/api/portals/v1/users/_this',
          {
            headers: {
              Authorization: `Token: ${await this.getLoginToken()}`,
            },
          },
        );
        return response.data;
      },
      { ttl: this.userInfoCacheTtl },
    );
  }

  private async getUserPortals(): Promise<AladdinPortal[]> {
    return this.cache.wrap(
      'getUserPortals',
      async () => {
        const { id } = await this.getUserInfo();
        const response = <AxiosResponse<AladdinPortal[]>>await this.session.get(
          `https://genie.exosite.com/api/portals/v1/users/${id}/portals`,
          {
            headers: {
              Authorization: `Token: ${await this.getLoginToken()}`,
            },
          },
        );
        return response.data;
      },
      { ttl: this.userInfoCacheTtl },
    );
  }

  private async getUserPortalDetails(id: string): Promise<AladdinPortalDetails> {
    return this.cache.wrap(
      `getUserPortalDetails:${id}`,
      async () => {
        const response = <AxiosResponse<AladdinPortalDetails>>await this.session.get(
          `https://genie.exosite.com/api/portals/v1/portals/${id}`,
          {
            headers: {
              Authorization: `Token: ${await this.getLoginToken()}`,
            },
          },
        );
        return response.data;
      },
      { ttl: this.userInfoCacheTtl },
    );
  }

  private async getPortalKey(id: string): Promise<string> {
    const {
      info: { key },
    } = await this.getUserPortalDetails(id);
    return key;
  }

  private async getUserPortalsDetails(): Promise<AladdinPortalDetails[]> {
    const portals = await this.getUserPortals();
    return Promise.all(portals.map(({ PortalID: id }) => this.getUserPortalDetails(id)));
  }

  private get userInfoCacheTtl(): number {
    return Math.max(
      AladdinConnect.USER_DATA_CACHE_TTL_S_MIN,
      Math.min(
        AladdinConnect.USER_DATA_CACHE_TTL_S_MAX,
        this.config.userInfoCacheTtl ?? AladdinConnect.USER_DATA_CACHE_TTL_S_DEFAULT,
      ),
    );
  }

  private get doorStatusStationaryCacheTtl(): number {
    return Math.max(
      AladdinConnect.DOOR_STATUS_STATIONARY_CACHE_TTL_S_MIN,
      Math.min(
        AladdinConnect.DOOR_STATUS_STATIONARY_CACHE_TTL_S_MAX,
        this.config.doorStatusStationaryCacheTtl ??
          AladdinConnect.DOOR_STATUS_STATIONARY_CACHE_TTL_S_DEFAULT,
      ),
    );
  }

  private get doorStatusTransitioningCacheTtl(): number {
    return Math.max(
      AladdinConnect.DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_MIN,
      Math.min(
        AladdinConnect.DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_MAX,
        this.config.doorStatusTransitioningCacheTtl ??
          AladdinConnect.DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_DEFAULT,
      ),
    );
  }

  private get pollInterval(): number {
    return Math.max(
      AladdinConnect.DOOR_STATUS_POLL_INTERVAL_MS_MIN,
      Math.min(
        AladdinConnect.DOOR_STATUS_POLL_INTERVAL_MS_MAX,
        this.config.doorStatusPollInterval ?? AladdinConnect.DOOR_STATUS_POLL_INTERVAL_MS_DEFAULT,
      ),
    );
  }

  private static getCallResult(callResponse, defaultValue?) {
    if (callResponse?.status !== 'ok') {
      return defaultValue;
    }
    return callResponse?.result?.[0]?.[1] ?? defaultValue;
  }

  private static doorStatusTopic(door: Omit<AladdinDoor, 'name'>): string {
    return `${AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC}.${door.device}.${door.id}`;
  }

  private static doorStatusCacheKey(door: Omit<AladdinDoor, 'name'>): string {
    return `${door.portal}:${door.device}:${door.id}`;
  }
}
