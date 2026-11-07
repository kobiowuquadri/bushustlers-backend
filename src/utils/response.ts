import type { Response } from 'express'

export interface ServiceResponse<T = unknown> {
  message: string
  success: boolean
  statusCode: number
  data: T
}

// message handler
export const messageHandler = <T = Record<string, never>>(message: string, success: boolean, statusCode: number, data: T = {} as T): ServiceResponse<T> => {
  return { message, success, statusCode, data }
}

// send a service result using its own status code
export const sendResponse = (res: Response, result: ServiceResponse) => {
  return res.status(result.statusCode).json(result)
}
