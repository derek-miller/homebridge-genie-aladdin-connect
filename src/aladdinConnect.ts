import { Logger } from 'homebridge';
import cacheManager, { Cache } from 'cache-manager';

import * as https from 'https';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';
import PubSub from 'pubsub-js';
import Token = PubSubJS.Token;
import AsyncLock from 'async-lock';
import { createHmac } from 'crypto';

interface AwsCognitoInitiateAuthResponse {
  AuthenticationResult: AwsCognitoAuthenticationResult;
  ChallengeParameters: never;
}

interface AwsCognitoAuthenticationResult {
  RefreshToken: string;
  TokenType: 'Bearer';
  ExpiresIn: number;
  IdToken: string;
  AccessToken: string;
}

interface AladdinDevicesEntity {
  devices: AladdinDeviceEntity[];
}

interface AladdinDeviceEntity {
  id: number;
  serial_number: string;
  name: string;
  is_locked: boolean;
  ssid: string;
  user_id: string;
  rssi: number;
  status: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  model: string;
  family: number;
  vendor: string;
  timezone: string;
  zipcode: string;
  is_expired: boolean;
  is_updating_firmware: boolean;
  doors: AladdinDoorEntity[];
  software_version: string;
  ownership: string;
}

interface AladdinDoorEntity {
  id: string;
  battery_level: number;
  created_at: string;
  updated_at: string;
  is_enabled: boolean;
  status: number;
  vehicle_type: string;
  vehicle_color: string;
  link_status: number;
  name: string;
  ble_strength: number;
  door_index: number;
  fault?: number;
}

export interface AladdinDoor {
  deviceId: number;
  id: string;
  index: number;
  serialNumber: string;
  name: string;
  hasBatteryLevel: boolean;
  ownership: string;
  status: AladdinDoorStatus;
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
  doorStatusStationaryCacheTtl?: number;
  doorStatusTransitioningCacheTtl?: number;
  doorStatusPollInterval?: number;
  logApiResponses?: boolean;
  showShared?: boolean;
}

export class AladdinConnect {
  private static readonly PUB_SUB_DOOR_STATUS_TOPIC = 'door';

  private static readonly DOOR_STATUS_STATIONARY_CACHE_TTL_S_DEFAULT = 15;
  private static readonly DOOR_STATUS_STATIONARY_CACHE_TTL_S_MIN = 5;
  private static readonly DOOR_STATUS_STATIONARY_CACHE_TTL_S_MAX = 60;

  private static readonly DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_DEFAULT = 5;
  private static readonly DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_MIN = 1;
  private static readonly DOOR_STATUS_TRANSITIONING_CACHE_TTL_S_MAX = 30;

  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_DEFAULT = 15 * 1000;
  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_MIN = 5 * 1000;
  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_MAX = 60 * 1000;

  private static readonly API_HOST = 'api.smartgarage.systems';
  private static readonly API_TIMEOUT = 5000;

  private static readonly AUTH_HOST = 'cognito-idp.us-east-2.amazonaws.com';
  private static readonly AUTH_CLIENT_ID = '27iic8c3bvslqngl3hso83t74b';
  private static readonly AUTH_CLIENT_SECRET =
    '7bokto0ep96055k42fnrmuth84k7jdcjablestb7j53o8lp63v5';

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
    });
    axiosRetry(this.session, {
      retries: 3,
      retryCondition: (error) => !error.response || error.response.status >= 400,
      shouldResetTimeout: true,
    });
  }

  subscribe(door: AladdinDoor, func: (info: AladdinDoor) => void): Token {
    const isFirstSubscription =
      PubSub.countSubscriptions(AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC) === 0;
    const token = PubSub.subscribe(AladdinConnect.doorStatusTopic(door), async (_, data) => {
      if (!data) {
        return;
      }
      func(data);
    });
    this.log.debug('[API] Status subscription added for door %s [token=%s]', door.name, token);

    // When this is the first subscription, start polling to publish updates.
    if (isFirstSubscription) {
      const poll = async () => {
        // Stop polling when there are no active subscriptions.
        if (PubSub.countSubscriptions(AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC) === 0) {
          this.log.debug('[API] There are no door status subscriptions; skipping poll');
          return;
        }
        // Acquire the status lock before emitting any new events.
        this.log.debug('[API] Polling status for all doors');
        try {
          (await this.getAllDoors()).map((doorStatus) => {
            PubSub.publish(AladdinConnect.doorStatusTopic(doorStatus), doorStatus);
          });
        } catch (error: unknown) {
          // getDoorStatus() logs any errors already.
        }
        setTimeout(poll, this.pollIntervalMs);
      };
      setTimeout(poll, 0);
    }
    return token;
  }

  // noinspection JSUnusedGlobalSymbols
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
            let response: AxiosResponse<AladdinDevicesEntity>;
            try {
              response = await this.session.get(`https://${AladdinConnect.API_HOST}/deep-refresh`, {
                headers: {
                  Authorization: `Bearer ${await this.getAccessToken()}`,
                },
              });
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
              device.doors.map((door) => {
                const name = door?.name || 'Garage Door';
                const status = door?.status ?? AladdinDoorStatus.UNKNOWN;
                const linkStatus = door?.link_status ?? AladdinLink.UNKNOWN;
                const batteryLevel = door?.battery_level ?? 0;
                const fault = !!door?.fault;
                return {
                  deviceId: device.id,
                  id: door.id,
                  index: door.door_index,
                  serialNumber: device.serial_number,
                  name,
                  // The devices that do not have batteries report a level of 0.
                  // I could not identify a better way to figure this out as I only have
                  // non-battery devices.
                  hasBatteryLevel: (door.battery_level ?? 0) > 0,
                  ownership: device.ownership,
                  status: status,
                  batteryPercent:
                    linkStatus === AladdinLink.CONNECTED && batteryLevel > 0 ? batteryLevel : null,
                  fault,
                };
              }),
            );
          },
          {
            ttl: (doors: AladdinDoor[]) =>
              doors.some((door) =>
                [AladdinDoorStatus.CLOSING, AladdinDoorStatus.OPENING].includes(
                  door?.status ?? AladdinDoorStatus.UNKNOWN,
                ),
              )
                ? this.doorStatusTransitioningCacheTtl
                : this.doorStatusStationaryCacheTtl,
          },
        ),
    );
  }

  async setDoorStatus(door: AladdinDoor, desiredStatus: AladdinDesiredDoorStatus): Promise<void> {
    return this.lock.acquire(AladdinConnect.DOOR_STATUS_LOCK, async () => {
      const command = desiredStatus === AladdinDesiredDoorStatus.OPEN ? 'OPEN_DOOR' : 'CLOSE_DOOR';
      let response: AxiosResponse;
      try {
        response = await this.session.post(
          `https://${AladdinConnect.API_HOST}/command/devices/${door.deviceId}/doors/${door.index}`,
          {
            command,
          },
          {
            headers: {
              Authorization: `Bearer ${await this.getAccessToken()}`,
            },
          },
        );
      } catch (error: unknown) {
        if (error instanceof Error) {
          this.log.error(
            '[API] An error occurred sending command %s to door %s; %s',
            command,
            door.name,
            error.message,
          );
        }
        throw error;
      }

      if (this.config.logApiResponses) {
        this.log.debug('[API] Genie %s response: %s', command, JSON.stringify(response.data));
      }

      await this.cache.del(AladdinConnect.doorStatusCacheKey(door));
    });
  }

  private async getAccessToken(): Promise<string> {
    return (
      await this.cache.wrap(
        'getAccessToken',
        async () => {
          let response: AxiosResponse<AwsCognitoInitiateAuthResponse>;
          try {
            response = await this.session.post(
              `https://${AladdinConnect.AUTH_HOST}`,
              {
                ClientId: AladdinConnect.AUTH_CLIENT_ID,
                AuthFlow: 'USER_PASSWORD_AUTH',
                AuthParameters: {
                  USERNAME: this.config.username,
                  PASSWORD: this.config.password,
                  SECRET_HASH: createHmac('sha256', AladdinConnect.AUTH_CLIENT_SECRET)
                    .update(this.config.username + AladdinConnect.AUTH_CLIENT_ID)
                    .digest('base64'),
                },
              },
              {
                headers: {
                  'Content-Type': 'application/x-amz-json-1.1',
                  'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
                },
              },
            );
          } catch (error: unknown) {
            if (error instanceof Error) {
              this.log.error(
                '[API] An error occurred getting operator oauth token; %s',
                error.message,
              );
            }
            throw error;
          }

          return response.data.AuthenticationResult;
        },
        { ttl: ({ ExpiresIn: expiresIn }) => expiresIn - 30 },
      )
    ).AccessToken;
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

  private get pollIntervalMs(): number {
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
