import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy import text
from contextlib import asynccontextmanager
import logging

logger = logging.getLogger(__name__)

# Get database credentials from environment variables
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_PORT = os.getenv("POSTGRES_PORT", "5432")
POSTGRES_DB = os.getenv("POSTGRES_DB", "idms")
POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "postgres")

# Build database URL
DATABASE_URL = f"postgresql+asyncpg://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"

# Create async engine
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    poolclass=NullPool,
    connect_args={
        "timeout": 10,
        "command_timeout": 30,
    },
)

# Create session factory
async_session = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
)


async def get_db():
    """Dependency to get database session"""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


@asynccontextmanager
async def get_async_session():
    """Context manager for database sessions"""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def check_db_connection():
    """Check if database is reachable"""
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as e:
        logger.error(f"Database connection failed: {str(e)}")
        return False
