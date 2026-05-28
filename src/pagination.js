function resolveLimit(limit) {
  const envDefault = Number(process.env.OFFERS_DEFAULT_LIMIT);
  const defaultLimit = envDefault > 0 ? envDefault : 50;
  const requested =
    limit === undefined || limit === "" ? defaultLimit : Number(limit);

  if (requested === 0 || String(limit).toLowerCase() === "all") {
    return 0;
  }

  const maxCap = Number(process.env.OFFERS_MAX_LIMIT) || 10000;
  return Math.min(Math.max(requested || defaultLimit, 1), maxCap);
}

function resolvePagination({ page, limit, offset } = {}) {
  const pageSize = resolveLimit(limit);
  const hasExplicitOffset = offset !== undefined && offset !== "";

  let pageNum = Math.max(Number(page) || 1, 1);
  let skip;

  if (hasExplicitOffset) {
    skip = Math.max(Number(offset) || 0, 0);
    if (pageSize > 0) {
      pageNum = Math.floor(skip / pageSize) + 1;
    }
  } else {
    skip = pageSize > 0 ? (pageNum - 1) * pageSize : 0;
  }

  return {
    page: pageNum,
    pageSize,
    limit: pageSize,
    offset: skip,
  };
}

function buildPaginationMeta({ total, page, pageSize }) {
  const safePageSize = pageSize > 0 ? pageSize : total || 1;
  const totalPages =
    pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  return {
    page,
    pageSize: safePageSize,
    limit: safePageSize,
    offset: pageSize > 0 ? (page - 1) * pageSize : 0,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

module.exports = {
  resolveLimit,
  resolvePagination,
  buildPaginationMeta,
};
