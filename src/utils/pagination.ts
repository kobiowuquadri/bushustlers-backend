export interface PaginationQuery {
  page?: unknown
  limit?: unknown
}

// Turn ?page=&limit= query params into safe values for Sequelize's limit/offset
export const getPagination = ({ page, limit }: PaginationQuery, defaultLimit = 10, maxLimit = 100) => {
  const pageNumber = Math.max(1, Number.parseInt(String(page), 10) || 1)
  const pageSize = Math.min(maxLimit, Math.max(1, Number.parseInt(String(limit), 10) || defaultLimit))
  return { page: pageNumber, limit: pageSize, offset: (pageNumber - 1) * pageSize }
}

// Shape a findAndCountAll() result into a paginated response body
export const paginate = <T>({ rows, count }: { rows: T[]; count: number }, page: number, limit: number) => {
  return {
    items: rows,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
      hasNextPage: page * limit < count
    }
  }
}
