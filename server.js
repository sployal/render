const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Supabase with service role key for admin operations
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// Basic middleware
app.use(helmet());
app.use(cors({
    origin: '*',
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// Helper function to upload image to Cloudinary
const uploadImageToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            {
                resource_type: 'image',
                folder: 'flodaz_community',
                transformation: [
                    { width: 800, height: 600, crop: 'limit' },
                    { quality: 'auto:good' }
                ]
            },
            (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result.secure_url);
                }
            }
        ).end(buffer);
    });
};

// Helper function to get user info from auth.users
const getUserInfo = (authUser) => {
    if (!authUser) return null;
    
    const metadata = authUser.raw_user_meta_data || {};
    return {
        id: authUser.id,
        email: authUser.email,
        fullName: metadata.full_name || metadata.name || authUser.email.split('@')[0],
        username: metadata.username || authUser.email.split('@')[0],
        accountType: metadata.account_type || 'free'
    };
};

// Helper function to create user avatar initials
const createAvatarInitials = (fullName) => {
    if (!fullName) return 'U';
    return fullName.split(' ')
        .map(name => name[0])
        .join('')
        .toUpperCase()
        .substring(0, 2);
};

// Routes
app.get('/', (req, res) => {
    res.json({ 
        message: 'Welcome to Flodaz Community API',
        version: '2.0.0',
        status: 'running',
        endpoints: {
            health: 'GET /api/health',
            posts: 'GET /api/posts',
            createPost: 'POST /api/posts',
            uploadImages: 'POST /api/upload-images',
            likePost: 'POST /api/posts/:id/like',
            getComments: 'GET /api/comments/:postId',
            createComment: 'POST /api/comments'
        }
    });
});

app.get('/api/health', async (req, res) => {
    try {
        // Test Supabase connection
        const { data, error } = await supabase.from('posts').select('count').limit(1);
        
        res.json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            message: 'Server is running successfully!',
            database: error ? 'Connection failed' : 'Connected'
        });
    } catch (error) {
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            message: 'Server running, database connection not tested',
            database: 'Unknown'
        });
    }
});

// Image upload endpoint
app.post('/api/upload-images', upload.array('images', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No images provided' });
        }

        const uploadPromises = req.files.map(file => 
            uploadImageToCloudinary(file.buffer)
        );

        const imageUrls = await Promise.all(uploadPromises);

        res.json({
            message: 'Images uploaded successfully',
            imageUrls
        });
    } catch (error) {
        console.error('Image upload error:', error);
        res.status(500).json({ error: 'Failed to upload images' });
    }
});

// Get posts with user information from auth.users
app.get('/api/posts', async (req, res) => {
    try {
        const { page = 1, limit = 10, type } = req.query;
        const offset = (page - 1) * limit;
        
        // Build query to get posts with user info
        let query = supabase
            .from('posts')
            .select(`
                id,
                user_id,
                type,
                title,
                content,
                images,
                tags,
                recipe_data,
                likes,
                shares,
                comment_count,
                created_at,
                updated_at
            `)
            .order('created_at', { ascending: false });
        
        if (type && type !== 'all') {
            query = query.eq('type', type);
        }
        
        const { data: posts, error } = await query
            .range(offset, offset + parseInt(limit) - 1);

        if (error) {
            console.error('Supabase posts fetch error:', error);
            return res.status(500).json({ error: 'Failed to fetch posts' });
        }

        // Get user information for each post
        const userIds = [...new Set(posts.map(post => post.user_id))];
        const { data: users, error: usersError } = await supabase.auth.admin.listUsers({
            filter: `id.in.(${userIds.join(',')})`
        });

        if (usersError) {
            console.error('Error fetching user data:', usersError);
        }

        // Create user lookup map
        const userMap = {};
        if (users && users.users) {
            users.users.forEach(user => {
                userMap[user.id] = getUserInfo(user);
            });
        }

        // Transform posts with user information
        const transformedPosts = posts.map(post => {
            const userInfo = userMap[post.user_id] || {
                fullName: 'Anonymous',
                username: 'anonymous',
                email: 'unknown@example.com'
            };

            return {
                id: post.id,
                type: post.type,
                title: post.title,
                content: post.content,
                images: post.images || [],
                tags: post.tags || [],
                likes: post.likes || 0,
                comments: post.comment_count || 0,
                shares: post.shares || 0,
                liked: false, // Would need user session to determine this
                bookmarked: false, // Would need user session to determine this
                timestamp: new Date(post.created_at).toLocaleString(),
                author: {
                    name: userInfo.fullName,
                    username: userInfo.username,
                    avatar: createAvatarInitials(userInfo.fullName)
                },
                recipe: post.recipe_data
            };
        });

        res.json({
            posts: transformedPosts,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: posts.length,
                hasMore: posts.length === parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Get posts error:', error);
        res.status(500).json({ error: 'Failed to fetch posts' });
    }
});

// Create new post
app.post('/api/posts', async (req, res) => {
    try {
        const { type, title, content, tags, images, recipe, userId } = req.body;
        
        if (!type || !title || !content) {
            return res.status(400).json({ error: 'Type, title, and content are required' });
        }

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const postData = {
            type,
            title,
            content,
            tags: Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()) : []),
            images: images || [],
            user_id: userId, // This should be a UUID from auth.users
            likes: 0,
            shares: 0,
            comment_count: 0,
            created_at: new Date().toISOString()
        };

        // Add recipe data if it's a recipe post
        if (type === 'recipe' && recipe) {
            postData.recipe_data = recipe;
        }

        const { data: newPost, error } = await supabase
            .from('posts')
            .insert([postData])
            .select()
            .single();

        if (error) {
            console.error('Supabase post creation error:', error);
            return res.status(500).json({ error: 'Failed to create post' });
        }

        // Get user info for the response
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        
        if (!userError && user) {
            userInfo = getUserInfo(user);
        }

        // Transform response to match frontend expectations
        const transformedPost = {
            id: newPost.id,
            type: newPost.type,
            title: newPost.title,
            content: newPost.content,
            images: newPost.images || [],
            tags: newPost.tags || [],
            likes: 0,
            comments: 0,
            shares: 0,
            timestamp: 'Just now',
            author: {
                name: userInfo.fullName,
                username: userInfo.username,
                avatar: createAvatarInitials(userInfo.fullName)
            },
            recipe: newPost.recipe_data
        };

        res.status(201).json({
            message: 'Post created successfully',
            post: transformedPost
        });
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

// Get single post
app.get('/api/posts/:id', async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        
        const { data: post, error } = await supabase
            .from('posts')
            .select('*')
            .eq('id', postId)
            .single();
        
        if (error || !post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // // Get user info
        const getUserInfo = (authUser) => {
            if (!authUser) return null;
            
            const metadata = authUser.raw_user_meta_data || {};
            
            // Get full name
            const fullName = metadata.full_name || metadata.name || authUser.email.split('@')[0];
            
            // Extract first name for fallback
            const firstName = fullName.split(' ')[0];
            
            // Priority: username > firstName > email prefix
            let username;
            if (metadata.username) {
                username = metadata.username;  // Use set username if available
            } else if (firstName && firstName !== authUser.email.split('@')[0]) {
                username = firstName;  // Use first name if it's not just the email prefix
            } else {
                username = authUser.email.split('@')[0];  // Final fallback to email prefix
            }
            
            return {
                id: authUser.id,
                email: authUser.email,
                fullName: fullName,
                username: username,
                accountType: metadata.account_type || 'free'
            };
        };



        res.json({ post: transformedPost });
    } catch (error) {
        console.error('Get post error:', error);
        res.status(500).json({ error: 'Failed to fetch post' });
    }
});

// Like post
app.post('/api/posts/:id/like', async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        
        // Get current likes count
        const { data: post, error: fetchError } = await supabase
            .from('posts')
            .select('likes')
            .eq('id', postId)
            .single();
        
        if (fetchError || !post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        // Increment likes
        const newLikesCount = (post.likes || 0) + 1;
        
        const { error: updateError } = await supabase
            .from('posts')
            .update({ likes: newLikesCount })
            .eq('id', postId);
        
        if (updateError) {
            console.error('Like update error:', updateError);
            return res.status(500).json({ error: 'Failed to like post' });
        }
        
        res.json({ 
            message: 'Post liked', 
            liked: true,
            likes: newLikesCount 
        });
    } catch (error) {
        console.error('Like post error:', error);
        res.status(500).json({ error: 'Failed to like post' });
    }
});

// Get comments for a post
app.get('/api/comments/:postId', async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        
        const { data: comments, error } = await supabase
            .from('comments')
            .select('*')
            .eq('post_id', postId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Comments fetch error:', error);
            return res.status(500).json({ error: 'Failed to fetch comments' });
        }

        // Get user information for each comment
        const userIds = [...new Set(comments.map(comment => comment.user_id))];
        const { data: users, error: usersError } = await supabase.auth.admin.listUsers({
            filter: `id.in.(${userIds.join(',')})`
        });

        // Create user lookup map
        const userMap = {};
        if (users && users.users && !usersError) {
            users.users.forEach(user => {
                userMap[user.id] = getUserInfo(user);
            });
        }

        const transformedComments = comments.map(comment => {
            const userInfo = userMap[comment.user_id] || {
                fullName: 'Anonymous',
                username: 'anonymous'
            };

            return {
                id: comment.id,
                content: comment.content,
                timestamp: new Date(comment.created_at).toLocaleString(),
                author: {
                    name: userInfo.fullName,
                    username: userInfo.username,
                    avatar: createAvatarInitials(userInfo.fullName)
                }
            };
        });
        
        res.json({ comments: transformedComments });
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// Create comment
app.post('/api/comments', async (req, res) => {
    try {
        const { postId, content, userId } = req.body;
        
        if (!postId || !content) {
            return res.status(400).json({ error: 'Post ID and content are required' });
        }

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        // Create comment
        const { data: newComment, error: commentError } = await supabase
            .from('comments')
            .insert([{
                post_id: parseInt(postId),
                user_id: userId, // UUID from auth.users
                content,
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (commentError) {
            console.error('Comment creation error:', commentError);
            return res.status(500).json({ error: 'Failed to create comment' });
        }

        // Update post comment count
        const { error: updateError } = await supabase
            .rpc('increment_comment_count', { post_id: parseInt(postId) });

        if (updateError) {
            console.error('Comment count update error:', updateError);
        }

        // Get user info for response
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        
        if (!userError && user) {
            userInfo = getUserInfo(user);
        }

        res.status(201).json({
            message: 'Comment created successfully',
            comment: {
                id: newComment.id,
                content: newComment.content,
                timestamp: 'Just now',
                author: {
                    name: userInfo.fullName,
                    username: userInfo.username,
                    avatar: createAvatarInitials(userInfo.fullName)
                }
            }
        });
    } catch (error) {
        console.error('Create comment error:', error);
        res.status(500).json({ error: 'Failed to create comment' });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
        }
    }
    
    res.status(500).json({ 
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`API docs: http://localhost:${PORT}/`);
});