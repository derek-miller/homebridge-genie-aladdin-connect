import { Logger } from 'homebridge';
import cacheManager, { Cache } from 'cache-manager';

import * as https from 'https';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';
import PubSub from 'pubsub-js';
import Token = PubSubJS.Token;
import AsyncLock from 'async-lock';
import { URLSearchParams } from 'url';

interface AladdinOauthResponse {
  refresh_token: string;
  token_type: 'bearer';
  user_id: number;
  expires_in: number;
  access_token: string;
  scope: 'operator';
}

interface AladdinConfigurationEntity {
  devices: AladdinDeviceEntity[];
}

interface AladdinDeviceEntity {
  is_locked: boolean;
  family: number;
  id: number;
  legacy_id: string;
  location_id: number;
  ssid: string;
  updated_at: string;
  user_id: number;
  rssi: number;
  model: string;
  description: string;
  legacy_key: string;
  created_at: string;
  lua_version: string;
  timezone: string;
  status: number;
  doors: AladdinDoorEntity[];
  is_enabled: boolean;
  zipcode: string;
  is_expired: boolean;
  location_name: string;
  serial: string;
  vendor: string;
  ownership: string;
  name: string;
  is_updating_firmware: boolean;
}

interface AladdinDoorEntity {
  desired_door_status_outcome: string;
  updated_at: string;
  desired_door_status: string;
  id: number;
  user_id: number;
  vehicle_color: string;
  door_index: number;
  icon: number;
  link_status: number;
  door_updated_at: string;
  created_at: string;
  desired_status: number;
  status: number;
  fault: number;
  ble_strength: number;
  is_enabled: boolean;
  battery_level: number;
  device_id: number;
  name: string;
  vehicle_type: string;
}

export interface AladdinDoor {
  deviceId: number;
  id: number;
  index: number;
  serialNumber: string;
  name: string;
  hasBatteryLevel: boolean;
  ownership: string;
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
  // noinspection JSUnusedGlobalSymbols
  UNKNOWN = 0,
  NOT_CONFIGURED = 1,
  PAIRED = 2,
  CONNECTED = 3,
}

export interface AladdinConnectConfig {
  username: string;
  password: string;
  batteryLowLevel?: number;
  userInfoCacheTtl?: number;
  doorStatusStationaryCacheTtl?: number;
  doorStatusTransitioningCacheTtl?: number;
  doorStatusPollInterval?: number;
  logApiResponses?: boolean;
  showShared?: boolean;
}

export class AladdinConnect {
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

  private static readonly API_HOST = 'pxdqkls7aj.execute-api.us-east-1.amazonaws.com';
  private static readonly API_TIMEOUT = 5000;
  private static readonly API_PATH_SEGMENT = 'Android';
  private static readonly API_APP_VERSION = '5.65';
  private static readonly DEFAULT_HEADERS = {
    app_version: AladdinConnect.API_APP_VERSION,
    'User-Agent': 'Aladdin%20Connect/79 CFNetwork/1399 Darwin/22.1.0',
    'X-API-KEY': 'fkowarQ0dX9Gj1cbB9Xkx1yXZkd6bzVn5x24sECW',
  };

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
      timeout: AladdinConnect.API_TIMEOUT,
      headers: {
        ...AladdinConnect.DEFAULT_HEADERS,
      },
    });
    axiosRetry(this.session, {
      retries: 3,
      retryCondition: (error) => !error.response || error.response.status >= 400,
      shouldResetTimeout: true,
    });
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
          PubSub.publish(topic, await this.getDoorStatus(door));
        } catch (error: unknown) {
          // getDoorStatus() logs any errors already.
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
    return this.lock.acquire(
      AladdinConnect.DOOR_STATUS_LOCK,
      async (): Promise<AladdinDoor[]> =>
        this.cache.wrap(
          'getAllDoors',
          async () => {
            let response;
            try {
              response = <AxiosResponse<AladdinConfigurationEntity>>await this.session.get(
                `https://${AladdinConnect.API_HOST}/${AladdinConnect.API_PATH_SEGMENT}/configuration`,
                {
                  headers: {
                    Authorization: `Bearer ${await this.getOauthToken()}`,
                  },
                },
              );
            } catch (error: unknown) {
              if (error instanceof Error) {
                this.log.error(
                  '[API] An error occurred getting devices from account; %s',
                  error.message,
                );
              }
              throw error;
            }

            if (this.config.logApiResponses) {
              this.log.debug('[API] Configuration response: %s', JSON.stringify(response.data));
            }

            return response.data.devices.flatMap((device) =>
              device.doors.map(
                (door) =>
                  <AladdinDoor>{
                    deviceId: device.id,
                    id: door.id,
                    index: door.door_index,
                    serialNumber: device.serial,
                    name: door.name,
                    // The devices that do not have batteries report a level of 0.
                    // I could not identify a better way to figure this out as I only have
                    // non-battery devices.
                    hasBatteryLevel: (door.battery_level ?? 0) > 0,
                    ownership: device.ownership,
                  },
              ),
            );
          },
          {
            ttl: this.userInfoCacheTtl,
          },
        ),
    );
  }

  async getDoorStatus(door: AladdinDoor): Promise<AladdinDoorStatusInfo> {
    return this.lock.acquire(
      AladdinConnect.DOOR_STATUS_LOCK,
      async (): Promise<AladdinDoorStatusInfo> =>
        this.cache.wrap(
          AladdinConnect.doorStatusCacheKey(door),
          async (): Promise<AladdinDoorStatusInfo> => {
            let response;
            try {
              response = <AxiosResponse<AladdinDeviceEntity>>await this.session.get(
                `https://${AladdinConnect.API_HOST}/${AladdinConnect.API_PATH_SEGMENT}/devices/${door.deviceId}`,
                {
                  headers: {
                    Authorization: `Bearer ${await this.getOauthToken()}`,
                  },
                },
              );
            } catch (error: unknown) {
              if (error instanceof Error) {
                this.log.error('[API] An error occurred getting device status; %s', error.message);
              }
              throw error;
            }
            if (this.config.logApiResponses) {
              this.log.debug(
                '[API] Device %s configuration response: %s',
                door.deviceId,
                JSON.stringify(response.data),
              );
            }

            const doorEntity = response.data.doors.find(
              ({ door_index: index }) => door.index === index,
            );
            const name = doorEntity?.name || 'Garage Door';
            const status = doorEntity?.status ?? AladdinDoorStatus.UNKNOWN;
            const desiredStatus = doorEntity?.desired_status ?? AladdinDesiredDoorStatus.NONE;
            const linkStatus = doorEntity?.link_status ?? AladdinLink.UNKNOWN;
            const batteryLevel = doorEntity?.battery_level ?? 0;
            const fault = !!doorEntity?.fault;
            return {
              door: {
                ...door,
                name,
              },
              status: status,
              desiredStatus,
              batteryPercent:
                linkStatus === AladdinLink.CONNECTED && batteryLevel > 0 ? batteryLevel : null,
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

  async setDoorStatus(door: AladdinDoor, desiredStatus: AladdinDesiredDoorStatus): Promise<void> {
    return this.lock.acquire(AladdinConnect.DOOR_STATUS_LOCK, async () => {
      const commandKey = desiredStatus === AladdinDesiredDoorStatus.OPEN ? 'OpenDoor' : 'CloseDoor';
      let response;
      try {
        response = await this.session.post(
          `https://${AladdinConnect.API_HOST}/${AladdinConnect.API_PATH_SEGMENT}/devices/${door.deviceId}/door/${door.index}/command`,
          {
            command_key: commandKey,
          },
          {
            headers: {
              Authorization: `Bearer ${await this.getOauthToken()}`,
            },
          },
        );
      } catch (error: unknown) {
        if (error instanceof Error) {
          this.log.error(
            '[API] An error occurred sending command %s to door %s; %s',
            commandKey,
            door.name,
            error.message,
          );
        }
        throw error;
      }

      if (this.config.logApiResponses) {
        this.log.debug('[API] Genie %s response: %s', commandKey, JSON.stringify(response.data));
      }

      await this.cache.del(AladdinConnect.doorStatusCacheKey(door));
    });
  }

  private async getOauthToken(): Promise<string> {
    return this.cache.wrap(
      'getOauthToken',
      async () => {
        const data = new URLSearchParams();
        data.append('grant_type', 'password');
        data.append('client_id', '1000');
        data.append('app_version', AladdinConnect.API_APP_VERSION);
        data.append('username', this.config.username);
        data.append('password', Buffer.from(this.config.password).toString('base64'));

        let response;
        try {
          response = <AxiosResponse<AladdinOauthResponse>>await this.session.post(
            `https://${AladdinConnect.API_HOST}/${AladdinConnect.API_PATH_SEGMENT}/oauth/token`,
            data,
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
            },
          );
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.log.error('[API] An error occurred getting oauth token; %s', error.message);
          }
          throw error;
        }

        return response.data.access_token;
      },
      { ttl: this.userInfoCacheTtl },
    );
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

  private static doorStatusTopic(door: AladdinDoor): string {
    return `${AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC}.${door.deviceId}.${door.index}`;
  }

  private static doorStatusCacheKey(door: AladdinDoor): string {
    return `${door.deviceId}:${door.index}`;
  }
}
